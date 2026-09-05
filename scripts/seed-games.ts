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
// For the hackathon this seeds a subset (default: released since 2023), not all
// 374,515 games. Full coverage can wait.

import {
  igdbQuery,
  seedPageQuery,
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
const resumeFrom = Number(process.env.SEED_RESUME_AFTER_ID ?? 0);

console.log(`seeding games released since ${since} (igdb id > ${resumeFrom})`);

let after = resumeFrom;
let total = 0;
let altTotal = 0;

for (;;) {
  const page = await igdbQuery<IgdbGame>(creds, "games", seedPageQuery(after, sinceUnix));
  if (page.length === 0) break;

  const ttbs = await fetchTimeToBeats(creds, page.map((g) => g.id));
  const rows = page.map((g) => mapIgdbGame(g, ttbs.get(g.id)));

  const { data, error } = await admin
    .from("games")
    .upsert(rows, { onConflict: "igdb_id" })
    .select("id, igdb_id");
  if (error) throw new Error(`games upsert failed at id ${after}: ${error.message}`);

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
    if (linkError) console.warn(`  platform links skipped at id ${after}: ${linkError.message}`);
  }

  // Alternative titles ("BG3", "GTA V", "BotW"). Warn-only for the same reason as
  // platform links: one bad page must not kill a long resumable run.
  const altRows = page.flatMap((g) => {
    const gameId = idByIgdb.get(g.id);
    return gameId ? mapAltTitles(g, gameId) : [];
  });
  if (altRows.length > 0) {
    const { error: altError } = await admin
      .from("game_alt_titles")
      .upsert(altRows, { onConflict: "game_id,match_title", ignoreDuplicates: true });
    if (altError) console.warn(`  alt titles skipped at id ${after}: ${altError.message}`);
    else altTotal += altRows.length;
  }

  total += page.length;
  after = page[page.length - 1].id;
  // Resume point, so an interrupted seed does not start over.
  console.log(`games: ${total}  alt titles: ${altTotal}  (SEED_RESUME_AFTER_ID=${after})`);
}

console.log(`done. ${total} games, ${altTotal} alternative titles.`);
