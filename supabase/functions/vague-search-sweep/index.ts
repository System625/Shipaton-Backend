// POST /vague-search-sweep -> { swept, done, retried, failed }
//
// The worker that actually calls the model for vague search. Fired on a schedule,
// same shape as push-sweep: the pg_cron wiring is deliberately NOT in a migration
// (see push-sweep/index.ts's comment for why -- it needs the service role key in
// Vault for pg_net, and a migration file is a file committed to git). One-time SQL
// to run by hand goes in docs/research/push-notifications.md's neighbour once this
// ships; until a cron job calls it, nothing calls this at all and no jobs move.
//
// WHO MAY CALL THIS. Same as push-sweep: checks the service role key as the
// bearer token, not _shared/http.ts's authenticate() (there is no auth.users row
// for a service-role caller). pg_net supplies that key from Vault when the cron
// job fires.
//
// WHY THIS EXISTS SEPARATELY FROM vague-search. docs/research/semantic-search.md
// §7/§11: the model call measured median 25.7s, p90 68.8s, **max 227.5s** over 71
// real queries -- longer than any edge function invocation is allowed to run
// (150s wall clock), foreground or background. So this sweep bounds its OWN
// wall-clock budget across the whole batch, gives each job a fair slice of what's
// left, and simply leaves a job claimed-but-unfinished for the next pass if the
// budget runs out -- shelf_vague_search_claim_batch reclaims anything left
// 'processing' for more than 5 minutes, so nothing gets stuck forever.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { understand } from "../_shared/deepseek.ts";
import { sendOneSignalPush, OneSignalError } from "../_shared/onesignal.ts";

const BATCH = 5;
// Stays well under the platform's ~150s wall clock even counting the time already
// spent claiming the batch and writing results back.
const HARD_BUDGET_MS = 120_000;
// Below this much remaining budget, starting one more job is not worth the risk of
// it being killed mid-call (which would just leave it 'processing' for 5 minutes
// before the next sweep reclaims it) -- better to leave it 'pending' and pick it up
// immediately on the next scheduled pass.
const MIN_JOB_BUDGET_MS = 20_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (req.headers.get("Authorization") !== `Bearer ${serviceKey}`) {
    return errorResponse("this endpoint is for the scheduled sweep only", 401);
  }

  const deepseekKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!deepseekKey) {
    // Not an error -- see docs/research/semantic-search.md §11: settling the
    // DeepSeek balance / picking a provider is still open. A cron schedule wired
    // up ahead of that just idles harmlessly instead of alerting on every run.
    return json({ swept: 0, done: 0, retried: 0, failed: 0, note: "DEEPSEEK_API_KEY not configured" });
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const { data: jobs, error: claimError } = await admin
    .rpc("shelf_vague_search_claim_batch", { p_limit: BATCH })
    .returns<{ id: string; user_id: string; query: string; attempts: number }[]>();
  if (claimError) return errorResponse(claimError.message, 500);
  if (!jobs || jobs.length === 0) return json({ swept: 0, done: 0, retried: 0, failed: 0 });

  const apiKey = Deno.env.get("ONESIGNAL_REST_API_KEY");
  const appId = Deno.env.get("ONESIGNAL_APP_ID");

  const started = Date.now();
  let done = 0;
  let retried = 0;
  let failed = 0;
  let processed = 0;

  for (const job of jobs) {
    const remaining = HARD_BUDGET_MS - (Date.now() - started);
    if (remaining < MIN_JOB_BUDGET_MS) break; // left 'processing' -- reclaimed after 5 minutes
    processed++;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const understanding = await understand(job.query, {
        model: "deepseek-flash",
        apiKey: deepseekKey,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // The model answered but named nothing it's willing to stand behind -- a
      // real, done result, not a failure. It happens on 0 of 71 measured queries
      // (the model always guesses), but the grounding step can still zero out
      // every title if the catalog confirms none of them.
      let candidates: { game_id: string; title: string; score: number }[] = [];
      if (understanding.titles.length > 0) {
        const { data: grounded, error: groundError } = await admin
          .rpc("shelf_ground_titles", { titles: understanding.titles, per: 1 })
          .returns<{ needle: string; rank: number; game_id: string | null; title: string | null; score: number | null }[]>();
        if (groundError) throw new Error(`grounding: ${groundError.message}`);
        candidates = (grounded ?? [])
          .filter((r) => r.game_id)
          .map((r) => ({ game_id: r.game_id as string, title: r.title as string, score: r.score as number }));
      }

      const { error: completeError } = await admin.rpc("shelf_vague_search_job_complete", {
        p_job_id: job.id,
        p_candidates: candidates,
        p_confidence: understanding.confidence,
      });
      if (completeError) throw new Error(`complete: ${completeError.message}`);
      done++;

      // Cache hard, per §8 step 4 -- a repeat of this exact sentence should never
      // cost another model call. Best-effort: a cache-write failure must not turn
      // a real answer into a reported failure.
      if (candidates.length > 0) {
        const { error: cacheError } = await admin.rpc("shelf_vague_search_cache_put", {
          p_query: job.query,
          p_game_ids: candidates.map((c) => c.game_id),
        });
        if (cacheError) console.error(`vague search cache write failed: ${cacheError.message}`);
      }

      // Best-effort delivery, same pattern as push-sweep: OneSignal.login(<supabase
      // user id>) on the app side is what makes external_id targeting resolve with
      // no device-token table on our side. A failure here does not fail the job --
      // the answer is already saved and a poll or the next app open finds it.
      if (apiKey && appId && candidates.length > 0) {
        try {
          await sendOneSignalPush(apiKey, appId, {
            externalId: job.user_id,
            title: "Found your game",
            body: candidates[0].title,
          });
        } catch (e) {
          console.error(e instanceof OneSignalError ? e.message : String(e));
        }
      }
    } catch (e) {
      clearTimeout(timeout);
      const message = e instanceof Error ? e.message : String(e);
      const willRetry = job.attempts + 1 < 3;
      const { error: failError } = await admin.rpc("shelf_vague_search_job_fail", {
        p_job_id: job.id,
        p_error: message,
        p_retry: true,
      });
      if (failError) console.error(`vague search job_fail failed: ${failError.message}`);
      if (willRetry) retried++; else failed++;
    }
  }

  return json({ swept: processed, done, retried, failed });
});
