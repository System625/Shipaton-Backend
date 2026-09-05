// POST /share/resolve {url} -> {intakeId, extractedText, candidates[]}
//
// A share_intake row is written the instant the share arrives, before any matching.
// If resolution fails the link is still saved and the user can come back to it.
// Nothing a user shares is ever silently dropped (spec §3, §6).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, errorResponse, igdbCredentials, json, corsHeaders } from "../_shared/http.ts";
import { toCatalogGame, type CatalogRow } from "../_shared/catalog-game.ts";
import { detectProvider, extractCandidateTexts, fetchOEmbed } from "../_shared/oembed.ts";
import { ingestFromSearch } from "../_shared/ingest.ts";

const CONFIDENT = 0.55; // best guess, shown large at the top
const PLAUSIBLE = 0.30; // shown as alternatives; below this, unmatched

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  let rawUrl: string;
  try {
    ({ url: rawUrl } = await req.json());
  } catch {
    return errorResponse("expected JSON body {url}", 400);
  }
  if (!rawUrl || typeof rawUrl !== "string") return errorResponse("url is required", 400);

  const provider = detectProvider(rawUrl);

  const { data: intake, error: intakeError } = await auth.supabase
    .from("share_intake")
    .insert({ user_id: auth.userId, raw_url: rawUrl, provider, status: "pending" })
    .select("id")
    .single();
  if (intakeError) return errorResponse(intakeError.message, 500);

  let extractedText: string | null = null;
  let candidates: CatalogRow[] = [];

  try {
    const oembed = await fetchOEmbed(rawUrl, provider);
    extractedText = oembed?.title ?? null;

    if (extractedText) {
      for (const term of extractCandidateTexts(extractedText, provider).slice(0, 4)) {
        const { data } = await auth.supabase
          .rpc("shelf_search_games", { q: term, max_results: 5 })
          .returns<CatalogRow[]>();
        candidates = merge(candidates, data ?? []);
        if ((candidates[0]?.score ?? 0) >= CONFIDENT) break;
      }

      // Nothing convincing locally? One IGDB search, then look again.
      if ((candidates[0]?.score ?? 0) < CONFIDENT) {
        const term = extractCandidateTexts(extractedText, provider)[0];
        if (term) {
          const admin = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
          );
          const added = await ingestFromSearch(admin, igdbCredentials(), term);
          if (added > 0) {
            const { data } = await auth.supabase
              .rpc("shelf_search_games", { q: term, max_results: 5 })
              .returns<CatalogRow[]>();
            candidates = merge(candidates, data ?? []);
          }
        }
      }
    }
  } catch (e) {
    // The intake row survives regardless. The user sees a search box, not an error.
    console.error("share resolution failed", e);
  }

  const top = candidates
    .filter((c) => (c.score ?? 0) >= PLAUSIBLE)
    .slice(0, 5);

  await auth.supabase
    .from("share_intake")
    .update({
      extracted_text: extractedText,
      candidate_game_ids: top.map((c) => c.id),
      status: top.length > 0 ? "pending" : "unmatched",
    })
    .eq("id", intake.id);

  return json({
    intakeId: intake.id,
    provider,
    extractedText,
    // The confirm step is required. Silently adding the wrong game to someone's
    // backlog is the fastest way to kill trust in the one feature that makes this
    // app different.
    confident: (top[0]?.score ?? 0) >= CONFIDENT,
    candidates: top.map(toCatalogGame),
  });
});

function merge(existing: CatalogRow[], incoming: CatalogRow[]): CatalogRow[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const row of incoming) {
    const prev = byId.get(row.id);
    if (!prev || (row.score ?? 0) > (prev.score ?? 0)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
