// GET /search?q=  ->  CatalogGame[]
//
// Reads the local catalog first. IGDB encourages local storage and the catalog is
// seeded up front, so a live IGDB call is the exception, not the norm (spec §2).
//
// The search screen's filter header (Prysm - Search, pages 3-5) adds the rest of
// the query string: the Release Date pill, the Categories pill (genre + device
// type) and the Sort By portal. All of it is applied inside the RPC, before the
// row limit -- /search returns 10 rows, so a filter applied to the response
// instead of the query gives a near-empty list and reads as broken.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, errorResponse, igdbCredentials, json, corsHeaders } from "../_shared/http.ts";
import { toCatalogGame, type CatalogRow } from "../_shared/catalog-game.ts";
import { ingestFromSearch } from "../_shared/ingest.ts";

// Below this best-match score the local catalog has not really answered the query.
const LIVE_LOOKUP_THRESHOLD = 0.55;

const SORTS = ["best_match", "popular", "rating", "recent", "alpha"] as const;
type Sort = (typeof SORTS)[number];

// The five Device Type pills. `platforms.family` carries exactly these values.
const DEVICE_TYPES = ["playstation", "xbox", "nintendo", "pc", "mobile"] as const;

/** ISO date (YYYY-MM-DD) or null. Anything else is rejected rather than coerced. */
function isoDate(raw: string | null): string | null | undefined {
  if (raw === null || raw === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const d = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? undefined : raw;
}

/** Repeated params and comma-separated lists both work: ?genre=rpg&genre=fps or ?genre=rpg,fps */
function list(params: URLSearchParams, key: string): string[] {
  return params.getAll(key)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const params = new URL(req.url).searchParams;
  const q = params.get("q")?.trim() ?? "";
  if (q.length < 2) return json([]);

  const releaseFrom = isoDate(params.get("releaseFrom"));
  const releaseTo = isoDate(params.get("releaseTo"));
  if (releaseFrom === undefined || releaseTo === undefined) {
    return errorResponse("releaseFrom and releaseTo must be ISO dates (YYYY-MM-DD)", 400);
  }
  if (releaseFrom && releaseTo && releaseFrom > releaseTo) {
    return errorResponse("releaseFrom must not be after releaseTo", 400);
  }

  // An unknown genre pill is not an error -- genre_pills maps it to nothing and
  // the result is empty, which is the honest answer for `souls` and the other
  // three pills the catalog cannot serve yet. An unknown DEVICE type is rejected,
  // because there are only five and a typo there means the app is wrong.
  const genres = list(params, "genre");
  const devices = list(params, "device");
  const badDevice = devices.find((d) => !DEVICE_TYPES.includes(d as typeof DEVICE_TYPES[number]));
  if (badDevice) {
    return errorResponse(`unknown device type "${badDevice}" (${DEVICE_TYPES.join(", ")})`, 400);
  }

  const sortRaw = (params.get("sort") ?? "best_match").toLowerCase();
  if (!SORTS.includes(sortRaw as Sort)) {
    return errorResponse(`unknown sort "${sortRaw}" (${SORTS.join(", ")})`, 400);
  }
  const sort = sortRaw as Sort;

  const dirRaw = (params.get("sortDir") ?? "desc").toLowerCase();
  if (dirRaw !== "asc" && dirRaw !== "desc") {
    return errorResponse('sortDir must be "asc" or "desc"', 400);
  }

  const search = () =>
    auth.supabase.rpc("shelf_search_games", {
      q,
      max_results: 10,
      release_from: releaseFrom,
      release_to: releaseTo,
      pills: genres.length > 0 ? genres : null,
      device_types: devices.length > 0 ? devices : null,
      sort_by: sort,
      sort_dir: dirRaw,
    }).returns<CatalogRow[]>();

  let { data, error } = await search();
  if (error) return errorResponse(error.message, 500);

  // The live IGDB lookup only makes sense for an unfiltered best-match query. A
  // thin result under a filter usually means the filter is doing its job, not
  // that the catalog is missing the game -- and `score` is not the ordering key
  // once the caller has chosen a sort, so the threshold would be reading a number
  // that no longer means what it means here.
  const filtered = releaseFrom !== null || releaseTo !== null ||
    genres.length > 0 || devices.length > 0 || sort !== "best_match";

  const best = data?.[0]?.score ?? 0;
  if (!filtered && best < LIVE_LOOKUP_THRESHOLD) {
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
