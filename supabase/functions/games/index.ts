// GET /games/:id  ->  CatalogGame
// Deployed as `games`, so the real path is /functions/v1/games/<uuid>.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { toCatalogGame, type CatalogRow } from "../_shared/catalog-game.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const id = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!UUID.test(id)) return errorResponse("expected /games/<uuid>", 400);

  const { data, error } = await auth.supabase
    .from("games")
    .select(
      "id, title, slug, release_date, genres, cover_url, critic_score, " +
      "ttb_normally_hours, ttb_count, session_fit, " +
      "game_platforms(platforms(id, name, slug))",
    )
    .eq("id", id)
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
