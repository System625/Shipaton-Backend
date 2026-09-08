// POST /share-resolve {url} -> {intakeId, extractedText, candidates[]}
//
// The path is share-resolve, matching the function directory. It is NOT /share/resolve;
// the gateway routes on the directory name and there is no nested path.
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

// Which search term produced a row, so confidence can be judged against the text
// that actually found the game rather than the caption as a whole.
type Candidate = CatalogRow & { foundBy: string };

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

  /**
   * Is the best row good enough to stop looking, and to assert to the user?
   *
   * A YouTube title is a genuine attempt at the game's name, so trigram proximity
   * is real evidence and the threshold stands. A TikTok hashtag is not an attempt
   * at anything — it is a word someone tagged — so proximity means nothing there
   * and the bar is the stronger claim: the term IS one of this game's names, up to
   * spacing. See migration 20260908183000 for the pet video that proved it.
   */
  async function settled(best: Candidate | undefined): Promise<boolean> {
    if (!best || (best.score ?? 0) < PLAUSIBLE) return false;
    if (provider === "youtube") return (best.score ?? 0) >= CONFIDENT;
    const { data } = await auth.supabase.rpc("shelf_term_names_game", {
      term: best.foundBy,
      p_game_id: best.id,
    });
    return data === true;
  }

  let extractedText: string | null = null;
  let candidates: Candidate[] = [];
  let confident = false;

  try {
    const oembed = await fetchOEmbed(rawUrl, provider);
    extractedText = oembed?.title ?? null;

    if (extractedText) {
      const terms = extractCandidateTexts(extractedText, provider);

      for (const term of terms.slice(0, 4)) {
        const { data } = await auth.supabase
          .rpc("shelf_search_games", { q: term, max_results: 5 })
          .returns<CatalogRow[]>();
        candidates = merge(candidates, (data ?? []).map((row) => ({ ...row, foundBy: term })));
        // Stop on a match worth asserting, not merely on a high score. A caption
        // like "#aesthetic #eldenring" used to break here on the junk hit from the
        // first tag and never reach the tag naming the actual game.
        if (await settled(candidates[0])) {
          confident = true;
          break;
        }
      }

      // Nothing convincing locally? One IGDB search, then look again.
      if (!confident) {
        const term = terms[0];
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
            candidates = merge(candidates, (data ?? []).map((row) => ({ ...row, foundBy: term })));
            confident = await settled(candidates[0]);
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
    // app different. `confident` only means "show this one large".
    confident,
    candidates: top.map(toCatalogGame),
  });
});

function merge(existing: Candidate[], incoming: Candidate[]): Candidate[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  for (const row of incoming) {
    const prev = byId.get(row.id);
    if (!prev || (row.score ?? 0) > (prev.score ?? 0)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
