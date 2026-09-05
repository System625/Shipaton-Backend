// GET /search?q=  ->  CatalogGame[]
//
// Reads the local catalog first. IGDB encourages local storage and the catalog is
// seeded up front, so a live IGDB call is the exception, not the norm (spec §2).

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, errorResponse, igdbCredentials, json, corsHeaders } from "../_shared/http.ts";
import { toCatalogGame, type CatalogRow } from "../_shared/catalog-game.ts";
import { ingestFromSearch } from "../_shared/ingest.ts";

// Below this best-match score the local catalog has not really answered the query.
const LIVE_LOOKUP_THRESHOLD = 0.55;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return json([]);

  const search = () =>
    auth.supabase.rpc("shelf_search_games", { q, max_results: 10 })
      .returns<CatalogRow[]>();

  let { data, error } = await search();
  if (error) return errorResponse(error.message, 500);

  const best = data?.[0]?.score ?? 0;
  if (best < LIVE_LOOKUP_THRESHOLD) {
    try {
      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const added = await ingestFromSearch(admin, igdbCredentials(), q);
      if (added > 0) {
        const retry = await search();
        if (!retry.error) data = retry.data;
      }
    } catch (e) {
      // A live-lookup failure is not a search failure. Serve what the catalog has.
      console.error("live IGDB lookup failed", e);
    }
  }

  return json((data ?? []).map(toCatalogGame));
});
