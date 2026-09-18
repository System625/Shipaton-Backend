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
  releasePrecision,
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
  release_precision: "day" | "month" | "quarter" | "year" | null;
  cover_url: string | null;
  genres: string[];
  // Descriptive text. See migration 20260911120000_descriptive_fields.sql for
  // coverage numbers and for why `keywords` is stored but must not be trusted.
  summary: string | null;
  storyline: string | null;
  themes: string[];
  perspectives: string[];
  keywords: string[];
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

// THE 1000h GUARD ABOVE ONLY CATCHES THE ABSURD. It does not catch merely wrong,
// and merely wrong is what reaches the screen: on 18 Sep 2026 the live detail screen
// for Grand Theft Auto: Vice City read "135h to beat" (a ~30h game), off a row whose
// own numbers contradict each other —
//
//   ttb_hastily 876.0   ttb_normally 134.6   ttb_completely 181.8   ttb_count 13
//
// 876 < 1000, so it passed. But `hastily` cannot exceed `completely`: they are the
// same quantity measured three ways, so `hastily <= normally <= completely` is a
// property the triple MUST have, and a triple that breaks it is not partially wrong,
// it is untrustworthy. Once the ordering is broken there is no way to tell from the
// data which of the three is the bad submission — Vice City's `hastily` is the
// obvious outlier, but `normally` is wrong too, and nothing in the row says so.
//
// WHY A TOLERANCE RATHER THAN A STRICT `<=`. Measured across the 5,994 catalog rows
// carrying any time-to-beat: 298 break the ordering at all, but most break it by
// noise. Wolfenstein: The New Order reports hastily 13.0 against normally 12.2 off
// 24 submissions; The Last of Us Part I 19.5 against 19.0 off 20. Those are crowd
// medians disagreeing in the last digit and `normally` is perfectly usable. A strict
// comparison would throw away all of them. Counts at each threshold:
//
//   > 0%    298 rows      > 25%   153 rows      > 100%   56 rows
//   > 10%   241 rows      > 50%    97 rows
//
// 25% is the knee, and it is chosen against named games rather than by eye: it keeps
// Wolfenstein (1.066), CoD 4 (1.033), Metro 2033 (1.029), GTA IV (1.094) and
// San Andreas (1.083), and drops Vice City (6.508), Overwatch (32.420 — 810h to beat
// "normally" against 25h completely), Super Mario Bros. (5.905), Fallout 2 (2.600),
// Crysis (2.196) and Metal Gear Solid (1.803). Tune it here; nothing else reads it.
//
// `ttb_count` goes with them. It is the submission count behind the three values, so
// keeping it beside three NULLs would describe evidence that is no longer there.
//
// NOT FIXED BY THIS, and worth knowing before trusting any of these numbers:
// 57.7% of the catalog's surviving `normally` values (2,947 of 5,106) rest on a
// SINGLE submission and 84.0% on three or fewer, and the app shows the figure with
// no sample size next to it. That is a product question,
// not a data-quality one — see docs/research/quick-view-card.md §7.
const TTB_ORDER_TOLERANCE = 1.25;

type TtbTriple = {
  hastily: number | null;
  normally: number | null;
  completely: number | null;
  count: number | null;
};

/**
 * Applies the ordering check above. Pairs are only compared when both sides are
 * present — a missing `completely` is the normal case, not a contradiction — and a
 * zero or negative reading is treated as contradictory rather than dividing by it.
 */
export function guardTtbOrder(triple: TtbTriple): TtbTriple {
  const { hastily, normally, completely } = triple;
  const pairs: [number | null, number | null][] = [
    [hastily, normally],
    [normally, completely],
    [hastily, completely],
  ];

  for (const [lower, upper] of pairs) {
    if (lower == null || upper == null) continue;
    if (upper <= 0 || lower / upper > TTB_ORDER_TOLERANCE) {
      return { hastily: null, normally: null, completely: null, count: null };
    }
  }
  return triple;
}

export function mapIgdbGame(game: IgdbGame, ttb: IgdbTimeToBeat | undefined): GameUpsert {
  // The ordering check runs on the CONVERTED values, after the 1000h guard, so a
  // reading that is nulled for being absurd cannot then make its siblings look
  // contradictory. `ttbNormally` is read again below by deriveSessionFit, so it has
  // to be the guarded value — otherwise a row could be filed as "low" on a number
  // the same mapper just decided not to store.
  const ttbHours = guardTtbOrder({
    hastily: secondsToHours(ttb?.hastily),
    normally: secondsToHours(ttb?.normally),
    completely: secondsToHours(ttb?.completely),
    count: ttb?.count ?? null,
  });
  const ttbNormally = ttbHours.normally;
  const genres = (game.genres ?? []).map((g) => g.name);
  // Computed once: deriveSessionFit() reads these, and now so does the row itself.
  const keywordNames = (game.keywords ?? []).map((k) => k.name);
  const gameModes = (game.game_modes ?? []).map((m) => m.name);
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
    release_precision: releasePrecision(game),
    cover_url: coverUrl(game.cover?.image_id),
    genres,
    // IGDB omits these rather than sending empty, so every one needs a fallback.
    // `summary` is present for 99.8% of rated games, `storyline` for only ~36% --
    // a null storyline is the normal case, not a fetch failure.
    summary: game.summary ?? null,
    storyline: game.storyline ?? null,
    themes: (game.themes ?? []).map((t) => t.name),
    perspectives: (game.player_perspectives ?? []).map((p) => p.name),
    keywords: keywordNames,
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
    ttb_hastily_hours: ttbHours.hastily,
    ttb_normally_hours: ttbHours.normally,
    ttb_completely_hours: ttbHours.completely,
    ttb_count: ttbHours.count,
    session_fit: deriveSessionFit({
      genres,
      gameModes,
      keywords: keywordNames,
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
