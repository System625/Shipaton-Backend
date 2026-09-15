// IGDB v4 client. Runtime-agnostic: no Deno or Node globals, so the same file
// backs both the edge functions and scripts/seed.ts.
//
// IGDB auth is Twitch OAuth. The token response carries `expires_in` (~64 days in
// IGDB's own example) — read the field, never hardcode a lifetime. Do not request
// a token per call. Spec section 2.

export type IgdbCredentials = { clientId: string; clientSecret: string };

type CachedToken = { token: string; expiresAt: number };

const tokenCache = new Map<string, CachedToken>();

export async function getAccessToken(creds: IgdbCredentials): Promise<string> {
  const cached = tokenCache.get(creds.clientId);
  // 60s of slack so a token cannot expire mid-flight.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const url =
    `https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(creds.clientId)}` +
    `&client_secret=${encodeURIComponent(creds.clientSecret)}&grant_type=client_credentials`;

  const res = await fetch(url, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Twitch token request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(creds.clientId, {
    token: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  });
  return body.access_token;
}

// IGDB allows 4 requests/second with at most 8 open at once, and 429s on overage.
// That is a concurrency limit, not a monthly quota (spec section 10).
const MIN_INTERVAL_MS = 250;
let nextSlot = 0;

async function throttle(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_INTERVAL_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
}

/** POST an Apicalypse query. `endpoint` is e.g. "games", "platforms". */
export async function igdbQuery<T>(
  creds: IgdbCredentials,
  endpoint: string,
  query: string,
  attempt = 0,
): Promise<T[]> {
  await throttle();
  const token = await getAccessToken(creds);
  const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: "POST",
    headers: {
      "Client-ID": creds.clientId,
      Authorization: `Bearer ${token}`,
      "Content-Type": "text/plain",
      Accept: "application/json",
    },
    body: query,
  });

  if (res.status === 429 && attempt < 5) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    return igdbQuery<T>(creds, endpoint, query, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`IGDB ${endpoint} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ---- Response shapes, only the fields we ask for ----

export type IgdbGame = {
  id: number;
  name: string;
  slug?: string;
  first_release_date?: number; // unix SECONDS
  cover?: { image_id: string };
  genres?: { name: string }[];
  platforms?: number[];
  aggregated_rating?: number; // 0-100, external critic aggregate. NOT Metacritic.
  // IGDB's count of USER ratings. OMITTED, not zero, when a game has none -- so
  // `?? 0` is the correct read and `total_rating_count == null` never means
  // "unpopular" here, only "IGDB did not say".
  total_rating_count?: number;
  game_modes?: { name: string }[];
  keywords?: { name: string }[];
  // Descriptive text. All four are omitted rather than empty when IGDB has none;
  // `storyline` is absent for ~64% of even well-rated games, so treat a missing
  // one as normal rather than as a failed fetch.
  summary?: string;
  storyline?: string;
  themes?: { name: string }[];
  player_perspectives?: { name: string }[];
  game_type?: number; // 0 = main_game
  parent_game?: number;
  version_parent?: number;
  // Abbreviations, regional titles and alternate spellings. Written to
  // game_alt_titles, not to a column on games.
  alternative_names?: { name: string }[];
};

export type IgdbTimeToBeat = {
  id: number;
  game_id: number;
  hastily?: number;    // SECONDS
  normally?: number;   // SECONDS
  completely?: number; // SECONDS
  count?: number;
};

export type IgdbPlatform = {
  id: number;
  name: string;
  slug: string;
  abbreviation?: string;
  platform_family?: number;
};

// `alternative_names.name` is what lets "bg3" and "gta v" match anything at all: an
// abbreviation shares almost no trigrams with the full title, so without it those
// queries return nothing (see migration 20260905000900_alt_titles.sql).
//
// The field carries more than acronyms -- IGDB documents `comment` as "(Acronym,
// Working title, Japanese title etc)" -- so a lot of what comes back is CJK and
// Cyrillic that normalizes to junk. Migration 20260905001000 filters that at write
// time. How much useful acronym coverage IGDB actually has is UNMEASURED; check it
// during the seed. Requesting the field costs nothing now and a full re-seed later.
// `summary`, `storyline`, `themes` and `player_perspectives` were added on 11 Sep
// for vague search — see migration 20260911120000_descriptive_fields.sql. They cost
// nothing extra per request (Apicalypse charges per request, not per field) but
// they do enlarge the response: summary alone is a median 740 chars on rated games,
// so seed pages of 500 get meaningfully heavier. If the seed starts timing out,
// drop the page size before dropping fields.
export const GAME_FIELDS =
  "fields name, slug, first_release_date, cover.image_id, genres.name, platforms, " +
  "aggregated_rating, total_rating_count, game_modes.name, keywords.name, " +
  "summary, storyline, themes.name, player_perspectives.name, " +
  "game_type, parent_game, " +
  "version_parent, alternative_names.name;";

/**
 * Search IGDB. Filters to main games only — without `game_type = 0`, "Elden Ring"
 * returns the base game, Shadow of the Erdtree, the Deluxe bundle and assorted
 * packs as separate rows, and they all land on the confirm screen (spec section 4).
 *
 * `game_type = 0` is not enough on its own: **editions carry game_type 0 too**, and
 * are distinguished only by `version_parent`. Measured 7 Sep against the live API,
 * `search "elden ring"; where game_type = 0; limit 10` returned 6 editions in 10
 * rows (Collector's, Deluxe, Launch, Seeker's, two Nightreign) — so more than half
 * the limit was spent on rows the caller then discarded. Same query with all three
 * clauses returns 5 rows, 0 editions. Matches `seedPageQuery`, which always had
 * them.
 */
export function searchGamesQuery(term: string, limit = 20): string {
  const safe = term.replace(/"/g, '\\"');
  return (
    `${GAME_FIELDS} search "${safe}"; ` +
    `where game_type = 0 & parent_game = null & version_parent = null; ` +
    `limit ${limit};`
  );
}

// Every seed page carries the same three type clauses. Editions are game_type 0 and
// are caught only by `version_parent` — see searchGamesQuery above.
const SEED_TYPE_CLAUSES =
  "game_type = 0 & parent_game = null & version_parent = null";

/**
 * The IGDB game types the re-release pass admits — 8 Remake, 9 Remaster, 10
 * Expanded Game, 11 Port, 4 Standalone Expansion. See seedRereleasePageQuery.
 */
export const REREL_TYPES = [4, 8, 9, 10, 11] as const;

/**
 * One page of the recent-releases pass. Pages by id rather than deep `offset`,
 * which degrades badly past a few thousand rows. `limit` maxes at 500.
 */
export function seedPageQuery(afterId: number, releasedSinceUnix: number, limit = 500): string {
  return (
    `${GAME_FIELDS} ` +
    `where id > ${afterId} & ${SEED_TYPE_CLAUSES} ` +
    `& first_release_date >= ${releasedSinceUnix}; ` +
    `sort id asc; limit ${limit};`
  );
}

/**
 * One page of the back-catalogue pass — spec §2's "plus anything popular enough to
 * matter", which was specced and configured (`SEED_MIN_POPULARITY`) but never
 * implemented until 7 Sep.
 *
 * Shelf is a backlog app, so the pile skews *old*: measured against the live API,
 * a 2023-onwards seed contains none of Elden Ring (Feb 2022), The Witcher 3, GTA V,
 * Cyberpunk 2077, Breath of the Wild, RDR2, Hollow Knight or Stardew Valley — every
 * worked example in the spec, and every abbreviation case in STATUS §3b but `bg3`.
 *
 * `total_rating_count` is IGDB's count of user ratings. It decides what enters the
 * catalog here, and since 8 Sep it is also STORED on games and read by /games/popular
 * and by search ranking -- see migration 20260908153445_game_popularity.sql.
 * Thresholds measured 7 Sep, rows added on top of the window's 75,559:
 * >=5 -> 13,558   >=20 -> 5,439   >=50 -> 2,694   >=100 -> 1,568.
 *
 * The date ranges are deliberately disjoint (`<` here, `>=` above), so the two
 * passes cannot return the same row and the upserts cannot fight. Games with no
 * release date at all are in neither pass, which is intended — an undated row has
 * nothing for the finish card or roulette to work with.
 */
export function seedPopularPageQuery(
  afterId: number,
  releasedBeforeUnix: number,
  minRatingCount: number,
  limit = 500,
): string {
  return (
    `${GAME_FIELDS} ` +
    `where id > ${afterId} & ${SEED_TYPE_CLAUSES} ` +
    `& first_release_date < ${releasedBeforeUnix} ` +
    `& total_rating_count >= ${minRatingCount}; ` +
    `sort id asc; limit ${limit};`
  );
}

/**
 * The re-release pass, added 15 Sep 2026. Admits the versions people actually name.
 *
 * Passes 1 and 2 filter to `game_type = 0 & parent_game = null & version_parent =
 * null`, which correctly removes "Deluxe Edition" and DLC noise — and also removes
 * every remake, remaster, port and expanded edition, because those carry a
 * `parent_game`. Measured 11 Sep against live IGDB: **2,042 rows with >= 5 ratings
 * were excluded**, including Resident Evil 2 (2019), Resident Evil 4 (2023),
 * Persona 5 Royal, Mario Kart 8 Deluxe, The Last of Us Part I and Dark Souls:
 * Remastered. The catalog's `Resident Evil 2` was the 1998 original. Greenlit by
 * Josh 15 Sep; the full argument is research/semantic-search.md §5.
 *
 * ADMITTED: 8 Remake, 9 Remaster, 10 Expanded Game, 11 Port, 4 Standalone
 * Expansion. NOT 2 Expansion (meaningless without its base game), NOT 3 Bundle,
 * NOT 1 DLC. That list is a product decision, not a technical one — do not widen
 * it without re-reading §5.
 *
 * Three clauses this pass deliberately does NOT carry:
 *
 *  - **No `parent_game = null`.** It is the whole point: every row here has a
 *    parent — all 2,043 of them, measured.
 *  - **No `version_parent = null`.** This one lets 23 edition rows in, measured
 *    15 Sep: Bulletstorm: Full Clip Edition (94 ratings), Deus Ex: Game of the Year
 *    Edition (58), Age of Mythology: Extended Edition (51), and 20 more below 50.
 *    **Kept deliberately.** The three-clause filter on passes 1 and 2 exists to keep
 *    Deluxe and Collector's editions of a game we already hold off the confirm
 *    screen; these are a different animal — several are the canonical version people
 *    actually play (the GOTY Deus Ex, the Extended Edition of Age of Mythology), they
 *    carry suffixed titles so they never collide on exact match, and the ranking's
 *    popularity term puts the base game above them anyway. Filtering them would also
 *    move the pass off the 2,042 that §5's decision was measured on. `verify:seed-
 *    widening` §3 pins the set: it PASSES on 23-ish rows all under 150 ratings and
 *    FAILS if something big ever gets re-typed into that opening.
 *  - **No date window.** Passes 1 and 2 split the id space by release date so they
 *    cannot return the same row; this pass is disjoint from both by `game_type`
 *    instead, so it needs no window and must not have one — a 2019 remake of a 1998
 *    game belongs in the catalog whichever side of the window it falls.
 *  - **No popularity exemption for recent releases.** Pass 1 admits any main game
 *    since 2023 with no rating floor; this pass applies the floor to everything.
 *    That is on purpose: without it the pass admits thousands of unrated mobile
 *    ports. The floor is what makes the count 2,042 rather than tens of thousands.
 *
 * `game_type = (4,8,9,10,11)` is Apicalypse's "equal to any of" on a scalar field.
 * Verified against live IGDB rather than assumed — `npm run verify:seed-widening`
 * proves the union matches the five per-type queries exactly and that no other type
 * comes back.
 */
export function seedRereleasePageQuery(
  afterId: number,
  minRatingCount: number,
  limit = 500,
): string {
  return (
    `${GAME_FIELDS} ` +
    `where id > ${afterId} & game_type = (${REREL_TYPES.join(",")}) ` +
    `& total_rating_count >= ${minRatingCount}; ` +
    `sort id asc; limit ${limit};`
  );
}

export function timeToBeatQuery(gameIds: number[]): string {
  return (
    "fields game_id, hastily, normally, completely, count; " +
    `where game_id = (${gameIds.join(",")}); limit 500;`
  );
}

/**
 * Cover URLs are built by hand from image_id. The URL IGDB returns is `t_thumb`
 * and is too small to use (90x90). `_2x` is what a phone needs. An invalid size
 * token 404s rather than falling back.
 *
 * Sizes MEASURED by downloading the real images on 11 Sep 2026, not read off
 * IGDB's docs — this comment previously claimed `t_cover_big` was 264x374, which
 * is what IGDB publishes but not what it serves:
 *
 *   t_thumb  90x90   t_cover_big  264x352   t_cover_big_2x  528x704
 *   t_720p   540x720 t_1080p      810x1080
 *
 * Every one of those except t_thumb is 3:4 (0.750), and 14 of the 15 most-rated
 * covers measure exactly 528x704. The odd ones are small source images IGDB will
 * not upscale, so treat 3:4 as reliable but not guaranteed. 264x374 would be
 * 0.706 — a frame built to it letterboxes every cover in the app.
 */
export function coverUrl(imageId: string | undefined): string | null {
  if (!imageId) return null;
  return `https://images.igdb.com/igdb/image/upload/t_cover_big_2x/${imageId}.jpg`;
}
