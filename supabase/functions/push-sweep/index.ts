// POST /push-sweep -> { swept: number, sent: number, failed: number }
//
// Item 10 of the OneSignal plan: the worker that reads `notifications` and calls
// OneSignal. Fired on a schedule, not on insert — see the firing-decision comment
// in 20260915160000_push_pushed_at.sql for why. This function is the whole sweep;
// the pg_cron schedule that calls it is deliberately NOT in a migration, because
// wiring it up means putting the project's service role key into Postgres (via
// Vault, for pg_net to read), and a migration file is a file committed to git.
// See docs/research/push-notifications.md for the one-time SQL to run by hand
// once ONESIGNAL_REST_API_KEY and ONESIGNAL_APP_ID exist.
//
// WHO MAY CALL THIS. Not a user-facing endpoint — nobody has a reason to trigger a
// push sweep from the app, and letting anyone do so would let anyone force-send
// every pending notification early or hammer OneSignal's rate limit. So this
// checks for a service-role credential itself as the bearer token, rather than
// using _shared/http.ts's authenticate(), which resolves a *user* from the token
// and would reject a service-role caller outright (there is no auth.users row for
// it). pg_net supplies that credential from Vault when the cron job fires; nothing
// else should have it.
//
// WHICH credential, precisely — see the same note in game-release-sweep/index.ts,
// confirmed live 17 Sep 2026: `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` inside a
// deployed function is this project's NEW-format secret key, not the legacy
// service_role JWT `.env` holds. Vault must get the new-format key
// (docs/research/push-notifications.md's wiring section spells out where).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { sendOneSignalPush, pushCopyFor, OneSignalError } from "../_shared/onesignal.ts";

// One run's worth. Keeps a sweep inside an edge function's CPU/time budget even if
// the table falls behind (a burst of likes on a popular post, or a sweep that
// missed a few cycles) — the unswept remainder just waits for the next run, which
// `pushed_at is null` makes free to do.
const BATCH = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (req.headers.get("Authorization") !== `Bearer ${serviceKey}`) {
    return errorResponse("this endpoint is for the scheduled sweep only", 401);
  }

  const apiKey = Deno.env.get("ONESIGNAL_REST_API_KEY");
  const appId = Deno.env.get("ONESIGNAL_APP_ID");
  if (!apiKey || !appId) {
    // Not an error: credentials are Josh's (item 4 of the OneSignal plan) and have
    // not arrived yet. Reporting 0/0/0 here rather than 500 means a cron schedule
    // wired up ahead of the keys just idles harmlessly instead of alerting on
    // every run.
    return json({ swept: 0, sent: 0, failed: 0, note: "ONESIGNAL credentials not configured" });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
  );

  // shelf_next_push_batch does the notifications-join-profiles work in SQL (no FK
  // for PostgREST to embed through — see the comment on it in
  // 20260915160000_push_pushed_at.sql) and is revoked from every role but this
  // one, which calls it with the service role key.
  const { data: rows, error } = await admin.rpc("shelf_next_push_batch", { p_limit: BATCH });
  if (error) return errorResponse(error.message, 500);
  if (!rows || rows.length === 0) return json({ swept: 0, sent: 0, failed: 0 });

  let sent = 0;
  let failed = 0;
  for (const row of rows as {
    id: string;
    user_id: string;
    kind: string;
    actor_display_name: string | null;
    game_title: string | null;
  }[]) {
    // game_release rows have no actor; every other kind has no game. Pick whichever
    // this row actually carries rather than assuming actor_display_name (see
    // 20260917140000 on why the old inner join used to make that safe to assume).
    const name = row.kind === "game_release" ? row.game_title : row.actor_display_name;
    if (!name) {
      // Shouldn't happen — game_release_has_game and the notify triggers both
      // guarantee this — but a null title/actor is a card with nothing to say,
      // not a retry-worthy failure, so it's skipped rather than sent broken.
      failed++;
      console.error(`notification ${row.id} (${row.kind}) has no name to render`);
      continue;
    }
    const { title, body } = pushCopyFor(
      row.kind as "follow" | "post_like" | "post_comment" | "game_release" | "post_repost" | "post_mention",
      name,
    );
    try {
      await sendOneSignalPush(apiKey, appId, { externalId: row.user_id, title, body });
      await admin.from("notifications").update({ pushed_at: new Date().toISOString() }).eq("id", row.id);
      sent++;
    } catch (e) {
      // Left unpushed on purpose — the next sweep retries it. A OneSignal outage
      // or a transient 5xx must not silently drop a notification.
      failed++;
      console.error(e instanceof OneSignalError ? e.message : String(e));
    }
  }

  return json({ swept: rows.length, sent, failed });
});
