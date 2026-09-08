// GET /roulette?platform=&hours=&size=  ->  CatalogGame | null
//
// Two inputs, not one (spec §7, Josh's decision 7):
//   hours  — how long you have got tonight. Reweights, never filters.
//   size   — how big a game you are in the mood for. 'quick' | 'medium' | 'epic'.
//
// "I have 1 hour" is session length; every games database publishes only total
// time to beat. Filtering one on the other deals everybody the same three short
// indies forever and never surfaces the 55-hour game you have 40 hours left in.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { toCatalogGame, type CatalogRow } from "../_shared/catalog-game.ts";

const SIZE_BUCKETS = new Set(["quick", "medium", "epic"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const params = new URL(req.url).searchParams;

  // Number(null) is 0 and Number("") is 0, and Number.isInteger(0) is true — so
  // testing the coerced value alone let a MISSING platform through as platform 0,
  // which matches no row and returned `null`. A caller who forgot the parameter got
  // the same answer as a caller with an empty backlog. Check the raw string first.
  const platformRaw = params.get("platform")?.trim();
  if (!platformRaw) return errorResponse("platform is required", 400);
  const platformId = Number(platformRaw);
  if (!Number.isInteger(platformId)) return errorResponse("platform must be an integer platform id", 400);

  const size = params.get("size");
  if (size && !SIZE_BUCKETS.has(size)) {
    return errorResponse("size must be quick, medium or epic", 400);
  }

  // Anything unparseable or non-positive falls back to 2. Zero and negatives are
  // not a shorter evening, they are nonsense, and they would silently select the
  // short-session weighting.
  const hours = Number(params.get("hours") ?? 2);

  const { data, error } = await auth.supabase
    .rpc("shelf_roulette", {
      p_user_id: auth.userId,
      p_platform_id: platformId,
      p_size_bucket: size,
      p_session_hours: Number.isFinite(hours) && hours > 0 ? hours : 2,
    })
    .returns<CatalogRow[]>();

  if (error) return errorResponse(error.message, 500);

  // Null means the backlog is empty on that platform, which is a real answer.
  // It should never mean "your filters excluded everything".
  return json(data?.[0] ? toCatalogGame(data[0]) : null);
});
