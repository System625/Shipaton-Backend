// GET /games/:id                    ->  CatalogGame          (and records the view)
// GET /games/popular                ->  CatalogGame[]
// GET /games/popular-with-friends   ->  (CatalogGame & { friendCount })[]
// GET /games/recently-viewed        ->  (CatalogGame & { viewedAt })[]
//
// Deployed as `games`, so the real paths are /functions/v1/games/<uuid>,
// /functions/v1/games/popular, /functions/v1/games/popular-with-friends and
// /functions/v1/games/recently-viewed. Supabase routes an edge function by its FIRST
// path segment, so all four live in this one function -- a separate `popular`
// function would have to answer on /functions/v1/popular, which is not where a
// /games collection belongs. No literal segment is a valid uuid, so they cannot
// collide with an id.

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

  // Why this exists rather than letting the app call the RPC directly: the RPC returns
  // the raw catalog row, and `abbreviation` and `colorKey` are NOT columns -- they are
  // derived in toCatalogGame(). An app calling shelf_popular_with_friends over
  // PostgREST would get neither, and GameCover.tsx resolves a missing colorKey as
  // `coverColors[colorKey] ?? coverColors.slate`, so every cover would render the same
  // grey with no error on either side. That exact drift already cost this project once
  // (see the note in _shared/catalog-game.ts). One thin route is cheaper than a second
  // copy of the mapping living in the app.
  //
  // `friendCount` is additive on top of CatalogGame -- the rest of the object is
  // byte-identical to what /search, /games/:id and /games/popular return, so the app
  // needs no new type to render these in the same component.
  if (segment === "popular-with-friends") {
    const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);

    const { data, error } = await auth.supabase
      .rpc("shelf_popular_with_friends", { max_results: limit, p_offset: offset })
      .returns<(CatalogRow & { friend_count: number })[]>();

    if (error) return errorResponse(error.message, 500);
    return json((data ?? []).map((row) => ({
      ...toCatalogGame(row),
      friendCount: Number(row.friend_count),
    })));
  }

  // The rail behind /games/:id's side effect below. Same twelve columns as the other
  // two list routes so the app renders all three through one component; `viewedAt` is
  // additive, exactly like `friendCount`.
  if (segment === "recently-viewed") {
    const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);

    const { data, error } = await auth.supabase
      .rpc("shelf_recently_viewed", { max_results: limit, p_offset: offset })
      .returns<(CatalogRow & { viewed_at: string })[]>();

    if (error) return errorResponse(error.message, 500);
    return json((data ?? []).map((row) => ({
      ...toCatalogGame(row),
      viewedAt: row.viewed_at,
    })));
  }

  if (segment === "popular") {
    const limit = intParam(url, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);

    const { data, error } = await auth.supabase
      .rpc("shelf_popular_games", { max_results: limit, p_offset: offset })
      .returns<CatalogRow[]>();

    if (error) return errorResponse(error.message, 500);
    return json((data ?? []).map(toCatalogGame));
  }

  if (!UUID.test(segment)) {
    return errorResponse("expected /games/<uuid>, /games/popular or /games/popular-with-friends", 400);
  }

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

  // `watching`/`watcherCount` for the Release-Day Tracker (game_watches,
  // 20260917120000) -- additive on top of CatalogGame, same pattern as
  // `friendCount` and `viewedAt` above: the rest of the object stays
  // byte-identical to what /search and /games/popular return.
  //
  // `watching` is a plain select under the caller's own JWT: RLS on game_watches
  // scopes it to their own row regardless, so this reads correctly with no
  // DEFINER function involved. `watcherCount` is the true total across every
  // user and RLS would answer "0 or 1" for that, so it goes through the
  // SECURITY DEFINER aggregate instead.
  const [{ data: ownWatch }, { data: watcherCount, error: watcherCountError }] = await Promise.all([
    auth.supabase.from("game_watches").select("user_id").eq("game_id", segment).maybeSingle(),
    auth.supabase.rpc("shelf_game_watcher_count", { p_game_id: segment }),
  ]);
  if (watcherCountError) return errorResponse(watcherCountError.message, 500);

  // Recording the view happens HERE rather than in the app, because fetching a game
  // to render its detail screen IS the view. One call, nothing for the client to
  // remember, and no way for "what the app shows" and "what the server recorded" to
  // drift -- the failure mode that the wishlist, the library and colorKey all hit in
  // their own way.
  //
  // Two properties this must have. It must never fail the read -- a game that renders
  // is worth more than a history row, so an error is logged and swallowed. And the
  // user must not wait on it: this is the game detail screen, and nobody should watch
  // a spinner for a rail they did not ask for.
  //
  // `?track=0` opts out. The app needs it for anything that fetches a game WITHOUT a
  // person looking at one -- re-hydrating a library list, prefetching the next card.
  // Without the escape hatch the rail fills up with games nobody opened, which is
  // indistinguishable from a bug and impossible to fix from the app's side.
  if (url.searchParams.get("track") !== "0") {
    const write = auth.supabase
      .rpc("shelf_track_game_view", { p_game_id: segment })
      .then(({ error: trackError }) => {
        if (trackError) console.error(`recently_viewed write failed: ${trackError.message}`);
      });

    // `EdgeRuntime.waitUntil` keeps the instance alive until the promise settles
    // without the response waiting on it -- Supabase's documented way to run work
    // outside the request handler ("Background Tasks"). Deliberately NOT awaited.
    // The fallback matters: the global is absent under some local runtimes, and a
    // floating promise there would be a write that silently never lands.
    const runtime = (globalThis as {
      EdgeRuntime?: { waitUntil(promise: Promise<unknown>): void };
    }).EdgeRuntime;
    if (runtime) runtime.waitUntil(write);
    else await write;
  }

  return json({
    ...toCatalogGame(row),
    watching: ownWatch != null,
    watcherCount: Number(watcherCount ?? 0),
  });
});
