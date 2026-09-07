// The write path: catalog upserts and the on-miss IGDB lookup.
// Requires a service-role client — the catalog is read-only to `authenticated`
// under RLS. Pure mapping lives in ./mapping.ts so the Node seed script can
// import it without pulling in supabase-js.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  igdbQuery,
  searchGamesQuery,
  type IgdbCredentials,
  type IgdbGame,
  type IgdbTimeToBeat,
} from "./igdb.ts";
import { fetchTimeToBeats, mapAltTitles, mapIgdbGame } from "./mapping.ts";

export async function upsertGames(
  admin: SupabaseClient,
  games: IgdbGame[],
  ttbs: Map<number, IgdbTimeToBeat>,
): Promise<{ id: string; igdb_id: number }[]> {
  if (games.length === 0) return [];

  const rows = games.map((g) => mapIgdbGame(g, ttbs.get(g.id)));
  const { data, error } = await admin
    .from("games")
    .upsert(rows, { onConflict: "igdb_id" })
    .select("id, igdb_id");
  if (error) throw new Error(`games upsert failed: ${error.message}`);

  const written = (data ?? []) as { id: string; igdb_id: number }[];
  const idByIgdb = new Map(written.map((r) => [r.igdb_id, r.id]));

  const links: { game_id: string; platform_id: number }[] = [];
  for (const g of games) {
    const gameId = idByIgdb.get(g.id);
    if (!gameId) continue;
    for (const platformId of g.platforms ?? []) {
      links.push({ game_id: gameId, platform_id: platformId });
    }
  }

  if (links.length > 0) {
    // A platform IGDB knows about but we have not seeded would violate the FK.
    // Drop those links rather than failing the whole ingest.
    const { data: known } = await admin.from("platforms").select("id");
    const knownIds = new Set(((known ?? []) as { id: number }[]).map((p) => p.id));
    const valid = links.filter((l) => knownIds.has(l.platform_id));
    if (valid.length > 0) {
      const { error: linkError } = await admin
        .from("game_platforms")
        .upsert(valid, { onConflict: "game_id,platform_id", ignoreDuplicates: true });
      if (linkError) throw new Error(`game_platforms upsert failed: ${linkError.message}`);
    }
  }

  await upsertAltTitles(admin, games, idByIgdb);

  return written;
}

/**
 * Alternative titles ("BG3", "GTA V", "BotW"), which is what makes abbreviation
 * search work at all. Best-effort by design: a game with no alt titles is fine, and
 * losing them costs a few fuzzy matches, not the catalog row. So this never fails
 * the whole ingest -- unlike game_platforms, where a missing link means the roulette
 * silently cannot see the game on that platform.
 */
async function upsertAltTitles(
  admin: SupabaseClient,
  games: IgdbGame[],
  idByIgdb: Map<number, string>,
): Promise<void> {
  const rows = games.flatMap((g) => {
    const gameId = idByIgdb.get(g.id);
    return gameId ? mapAltTitles(g, gameId) : [];
  });
  if (rows.length === 0) return;

  // onConflict is the (game_id, match_title) primary key, but match_title is set by
  // a BEFORE trigger and is not known client-side, so conflicts cannot be named
  // here. ignoreDuplicates keeps a re-seed idempotent instead of erroring.
  const { error } = await admin
    .from("game_alt_titles")
    .upsert(rows, { onConflict: "game_id,match_title", ignoreDuplicates: true });
  if (error) console.warn(`game_alt_titles upsert skipped: ${error.message}`);
}

/** One IGDB search, ingested into the catalog. The on-miss path, not the norm. */
export async function ingestFromSearch(
  admin: SupabaseClient,
  creds: IgdbCredentials,
  term: string,
  limit = 20,
): Promise<number> {
  const games = await igdbQuery<IgdbGame>(creds, "games", searchGamesQuery(term, limit));
  // Belt and braces. The query filters all three fields server-side and IGDB does
  // honour them under `search` (verified 7 Sep — the earlier comment here claimed
  // `search` ignores some `where` clauses, which is not true of these three). Kept
  // because the cost is one pass over 20 rows and the failure mode is DLC and
  // editions reaching the confirm screen (spec §4).
  const mainGames = games.filter(
    (g) => g.game_type === 0 && g.parent_game == null && g.version_parent == null,
  );
  if (mainGames.length === 0) return 0;

  const ttbs = await fetchTimeToBeats(creds, mainGames.map((g) => g.id));
  return (await upsertGames(admin, mainGames, ttbs)).length;
}
