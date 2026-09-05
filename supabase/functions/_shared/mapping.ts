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
const secondsToHours = (s: number | undefined): number | null =>
  s == null ? null : Math.round((s / 3600) * 10) / 10;

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
