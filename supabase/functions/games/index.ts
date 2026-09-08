// GET /games/:id      ->  CatalogGame
// GET /games/popular  ->  CatalogGame[]
//
// Deployed as `games`, so the real paths are /functions/v1/games/<uuid> and
// /functions/v1/games/popular. Supabase routes an edge function by its FIRST path
// segment, so both live in this one function -- a separate `popular` function would
// have to answer on /functions/v1/popular, which is not where a /games collection
// belongs. `popular` is not a valid uuid, so the two cannot collide.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { toCatalogGame, type CatalogRow } from "../_shared/catalog-game.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A phone renders a handful of covers at a time and the whole list is only 15,948
// rows. The cap exists so one client cannot ask for all of them in a single call.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Query params are strings from an untrusted client; anything unusable falls back. */
function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const url = new URL(req.url);
  const segment = url.pathname.split("/").filter(Boolean).pop() ?? "";

  if (segment === "popular") {
    const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);

    const { data, error } = await auth.supabase
      .rpc("shelf_popular_games", { max_results: limit, p_offset: offset })
      .returns<CatalogRow[]>();

    if (error) return errorResponse(error.message, 500);
    return json((data ?? []).map(toCatalogGame));
  }

  if (!UUID.test(segment)) return errorResponse("expected /games/<uuid> or /games/popular", 400);

  const { data, error } = await auth.supabase
    .from("games")
    .select(
      "id, title, slug, release_date, genres, cover_url, critic_score, " +
      "ttb_normally_hours, ttb_count, session_fit, " +
      "game_platforms(platforms(id, name, slug))",
    )
    .eq("id", segment)
    .maybeSingle();

  if (error) return errorResponse(error.message, 500);
  if (!data) return errorResponse("game not found", 404);

  const nested = data as unknown as CatalogRow & {
    game_platforms: { platforms: { id: number; name: string; slug: string } }[];
  };
  const row: CatalogRow = {
    ...nested,
    platforms: (nested.game_platforms ?? []).map((gp) => gp.platforms).filter(Boolean),
  };

  return json(toCatalogGame(row));
});
