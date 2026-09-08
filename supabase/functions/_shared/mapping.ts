// IGDB rows -> our catalog rows. Pure: no database, no runtime-specific imports,
// so both the Deno edge functions and the Node seed script use the same mapping.
//
// Reminder from spec §3: `igdb_id` is a reference, not an identity. This file and
// scripts/seed-games.ts are the only places allowed to read it. That rule is what
// let the provider change from RAWG to IGDB in one afternoon, and what keeps the
// RAWG fallback in spec §11 a sync-layer change rather than a rewrite.

import {
  coverUrl,
  igdbQuery,
  timeToBeatQuery,
  type IgdbCredentials,
  type IgdbGame,
  type IgdbTimeToBeat,
} from "./igdb.ts";
import { deriveSessionFit } from "./session-fit.ts";

export type GameUpsert = {
  igdb_id: number;
  slug: string | null;
  title: string;
  match_title: string; // overwritten by the games_match_title trigger; sent for clarity
  release_date: string | null;
  release_tbd: boolean;
  cover_url: string | null;
  genres: string[];
  critic_score: number | null;
  total_rating_count: number;
  igdb_game_type: number | null;
  ttb_hastily_hours: number | null;
  ttb_normally_hours: number | null;
  ttb_completely_hours: number | null;
  ttb_count: number | null;
  session_fit: string;
  source: "igdb";
  synced_at: string;
};

// IGDB returns time to beat in SECONDS.
//
// Above this, treat the value as absent rather than real. IGDB's time-to-beat rows
// are user submissions and a few are plainly corrupt — "Where Winds Meet" reports
// 25,107 hours (2.9 years) to beat normally, off 7 submissions. Measured 7 Sep
// across the 7,534 entries that carry a `normally`: 110 exceed 200h, 49 exceed
// 1000h, 16 exceed 9999.9h.
//
// Two reasons null beats storing the number. `ttb_*_hours` is numeric(5,1), so
// anything >= 10000 fails the insert outright and takes the whole 500-row page with
// it (this is what broke the first seed run). And a garbage value is worse than no
// value downstream: deriveSessionFit and shelf_roulette both already handle a null
// time-to-beat — most games have no entry at all — but a 25,107h reading would rank
// a game as fitting no session ever, on one bad submission.
//
// 1000h is a judgement call, not a measured boundary. It sits well above the
// longest genuinely long games (completionist JRPGs land near 200h) and well below
// the corrupt cluster. Tune it here; nothing else reads it.
const TTB_MAX_PLAUSIBLE_HOURS = 1000;

const secondsToHours = (s: number | undefined): number | null => {
  if (s == null) return null;
  const hours = Math.round((s / 3600) * 10) / 10;
  return hours > TTB_MAX_PLAUSIBLE_HOURS ? null : hours;
};

export function mapIgdbGame(game: IgdbGame, ttb: IgdbTimeToBeat | undefined): GameUpsert {
  const ttbNormally = secondsToHours(ttb?.normally);
  const genres = (game.genres ?? []).map((g) => g.name);
  return {
    igdb_id: game.id,
    slug: game.slug ?? null,
    title: game.name,
    match_title: game.name, // the trigger normalizes it; see 20260905000400_matching.sql
    release_date: game.first_release_date
      // first_release_date is unix SECONDS, not milliseconds
      ? new Date(game.first_release_date * 1000).toISOString().slice(0, 10)
      : null,
    release_tbd: !game.first_release_date,
    cover_url: coverUrl(game.cover?.image_id),
    genres,
    // aggregated_rating is IGDB's aggregate of external critic scores, 0-100.
    // It is NOT Metacritic and must not be labelled as such in the UI.
    critic_score: game.aggregated_rating == null ? null : Math.round(game.aggregated_rating),
    // Count of USER ratings, and a different quantity from critic_score above: a
    // game can be widely played and mediocre, or acclaimed and obscure.
    //
    // IGDB omits this field rather than returning 0, so `?? 0` is not defensive
    // padding -- it is the only way a game with no ratings gets a number at all.
    // The column stays nullable so that NULL keeps meaning "never fetched"; every
    // row this mapper touches was fetched, so it always writes a real count.
    total_rating_count: game.total_rating_count ?? 0,
    igdb_game_type: game.game_type ?? null,
    ttb_hastily_hours: secondsToHours(ttb?.hastily),
    ttb_normally_hours: ttbNormally,
    ttb_completely_hours: secondsToHours(ttb?.completely),
    ttb_count: ttb?.count ?? null,
    session_fit: deriveSessionFit({
      genres,
      gameModes: (game.game_modes ?? []).map((m) => m.name),
      keywords: (game.keywords ?? []).map((k) => k.name),
      ttbNormallyHours: ttbNormally,
    }),
    source: "igdb",
    synced_at: new Date().toISOString(),
  };
}

export type AltTitleUpsert = {
  game_id: string;
  alt_title: string;
  match_title: string; // overwritten by the game_alt_titles_match_title trigger
};

/**
 * IGDB alternative names -> game_alt_titles rows. This is where "BG3", "GTA V" and
 * "BotW" come from; without them those queries match nothing at all.
 *
 * Two things are dropped here rather than in SQL:
 *  - anything equal to the game's own title, which would just duplicate a row the
 *    search already matches on games.match_title
 *  - blanks and whitespace-only entries, which IGDB does occasionally return
 *
 * Near-duplicates that only collide AFTER normalization ("GTA V" vs "GTA 5") are
 * NOT filtered here, deliberately: normalization is the database's job, and the
 * (game_id, match_title) primary key collapses them on insert. Doing it in
 * TypeScript would mean reimplementing shelf_match_title, which is the one thing
 * spec section 5 exists to prevent.
 */
export function mapAltTitles(game: IgdbGame, gameId: string): AltTitleUpsert[] {
  const seen = new Set<string>();
  const out: AltTitleUpsert[] = [];
  for (const alt of game.alternative_names ?? []) {
    const name = (alt?.name ?? "").trim();
    if (name === "") continue;
    if (name.toLowerCase() === game.name.trim().toLowerCase()) continue;
    // Cheap exact-duplicate guard so one page does not send the same row twice;
    // the real dedupe is the primary key.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ game_id: gameId, alt_title: name, match_title: name });
  }
  return out;
}

/** Time to beat is a separate endpoint, and not every game has an entry. */
export async function fetchTimeToBeats(
  creds: IgdbCredentials,
  gameIds: number[],
): Promise<Map<number, IgdbTimeToBeat>> {
  const out = new Map<number, IgdbTimeToBeat>();
  for (let i = 0; i < gameIds.length; i += 500) {
    const chunk = gameIds.slice(i, i + 500);
    if (chunk.length === 0) continue;
    const rows = await igdbQuery<IgdbTimeToBeat>(
      creds,
      "game_time_to_beats",
      timeToBeatQuery(chunk),
    );
    for (const row of rows) out.set(row.game_id, row);
  }
  return out;
}
