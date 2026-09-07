// Seeds the games catalog from the IGDB paginated API.
//
// Not from a data dump: those are partner-only ("Please note that data dumps are
// exclusively available to our Data Partners"). Not from an edge function either —
// those cap at 2s CPU / 150s wall clock on the free plan, which a bulk seed blows
// straight through (spec §9). This is a local script on purpose.
//
// Pages by `where id > last_id` rather than deep `offset`, which degrades badly.
// limit maxes at 500 and IGDB allows 4 req/sec, so ~100k games is ~200 requests
// for the games themselves plus the same again for time-to-beat.
//
// TWO PASSES, both from spec §2: "everything from the last 3 years, plus anything
// popular enough to matter". Only the first was implemented until 7 Sep, which left
// the catalog with none of Elden Ring, The Witcher 3, GTA V, Cyberpunk 2077, BotW,
// RDR2, Hollow Knight or Stardew Valley — the wrong half of the library for an app
// whose whole subject is the backlog you already own. See seedPopularPageQuery.
//
// Each pass resumes independently; an interrupted run prints the exact env var to
// set. The two id cursors are separate because the passes walk id space separately.

import {
  igdbQuery,
  seedPageQuery,
  seedPopularPageQuery,
  type IgdbGame,
} from "../supabase/functions/_shared/igdb.ts";
import {
  fetchTimeToBeats,
  mapAltTitles,
  mapIgdbGame,
} from "../supabase/functions/_shared/mapping.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";

const creds = igdbCreds();
const since = process.env.SEED_RELEASED_SINCE ?? "2023-01-01";
const sinceUnix = Math.floor(new Date(since).getTime() / 1000);
const minPopularity = Number(process.env.SEED_MIN_POPULARITY ?? 5);

/** Writes one page of IGDB games, with platform links and alt titles. */
async function writePage(page: IgdbGame[]): Promise<number> {
  const ttbs = await fetchTimeToBeats(creds, page.map((g) => g.id));
  const rows = page.map((g) => mapIgdbGame(g, ttbs.get(g.id)));

  const { data, error } = await admin
    .from("games")
    .upsert(rows, { onConflict: "igdb_id" })
    .select("id, igdb_id");
  if (error) throw new Error(`games upsert failed: ${error.message}`);

  const idByIgdb = new Map((data ?? []).map((r) => [r.igdb_id as number, r.id as string]));
  const links = page.flatMap((g) =>
    (g.platforms ?? []).flatMap((platformId) => {
      const gameId = idByIgdb.get(g.id);
      return gameId ? [{ game_id: gameId, platform_id: platformId }] : [];
    })
  );
  if (links.length > 0) {
    const { error: linkError } = await admin
      .from("game_platforms")
      .upsert(links, { onConflict: "game_id,platform_id", ignoreDuplicates: true });
    // A platform IGDB knows about but we have not seeded violates the FK. Seed
    // platforms first; this only warns so one bad row cannot kill a long run.
    if (linkError) console.warn(`  platform links skipped: ${linkError.message}`);
  }

  // Alternative titles ("BG3", "GTA V", "BotW"). Warn-only for the same reason as
  // platform links: one bad page must not kill a long resumable run.
  const altRows = page.flatMap((g) => {
    const gameId = idByIgdb.get(g.id);
    return gameId ? mapAltTitles(g, gameId) : [];
  });
  let altCount = 0;
  if (altRows.length > 0) {
    const { error: altError } = await admin
      .from("game_alt_titles")
      .upsert(altRows, { onConflict: "game_id,match_title", ignoreDuplicates: true });
    if (altError) console.warn(`  alt titles skipped: ${altError.message}`);
    else altCount = altRows.length;
  }
  return altCount;
}

/** Walks one pass to exhaustion, paging on ascending igdb id. */
async function runPass(
  label: string,
  resumeEnvVar: string,
  pageQuery: (afterId: number) => string,
): Promise<{ games: number; altTitles: number }> {
  let after = Number(process.env[resumeEnvVar] ?? 0);
  let games = 0;
  let altTitles = 0;
  console.log(`\n=== ${label} (resuming from igdb id > ${after}) ===`);

  for (;;) {
    const page = await igdbQuery<IgdbGame>(creds, "games", pageQuery(after));
    if (page.length === 0) break;

    altTitles += await writePage(page);
    games += page.length;
    after = page[page.length - 1].id;
    console.log(`  games: ${games}  alt titles: ${altTitles}  (${resumeEnvVar}=${after})`);
  }
  console.log(`${label}: ${games} games, ${altTitles} alternative titles.`);
  return { games, altTitles };
}

const recent = await runPass(
  `pass 1/2 — released since ${since}`,
  "SEED_RESUME_AFTER_ID",
  (afterId) => seedPageQuery(afterId, sinceUnix),
);

const backCatalogue = await runPass(
  `pass 2/2 — before ${since}, total_rating_count >= ${minPopularity}`,
  "SEED_RESUME_POPULAR_AFTER_ID",
  (afterId) => seedPopularPageQuery(afterId, sinceUnix, minPopularity),
);

console.log(
  `\ndone. ${recent.games + backCatalogue.games} games, ` +
  `${recent.altTitles + backCatalogue.altTitles} alternative titles ` +
  `(${recent.games} recent, ${backCatalogue.games} back catalogue).`,
);
