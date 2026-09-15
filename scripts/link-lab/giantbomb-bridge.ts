// Measures the GiantBomb ceiling: how much of our catalog would a Grouvee CSV
// import resolve DETERMINISTICALLY, via the `giantbomb_id` column its export
// carries, rather than by matching on the game's title?
//
// WHY THIS SCRIPT EXISTS. docs/research/account-linking.md section 10 originally
// scoped a CSV importer against four services (Backloggd, GG, Grouvee, Minimap) on
// the assumption all four export. RESEARCHED 15 Sep 2026: only Grouvee does, and
// its export carries a `giantbomb_id` column. IGDB's own `external_game_sources`
// lists source 3 as GiantBomb -- the same mechanism behind the Steam (source 1) and
// Android (source 15) direct joins -- but nobody had counted how much of the
// catalog it reaches. This is that count, same shape as
// scripts/link-lab/xbox-title-bridge.ts, minus the bridging step: GiantBomb ids
// join directly, there is no separate "store id -> platform id" hop to measure.
//
//   npx tsx scripts/link-lab/giantbomb-bridge.ts

import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { admin } from "../supabase-admin.ts";

const creds = igdbCreds();
const GIANTBOMB_SOURCE = 3;

/**
 * Every igdb_id in our catalog, plus the subset with >= 5 IGDB user ratings -- the
 * closer proxy for a played/tracked library, same reasoning as the Xbox bridge.
 * Keyset paged on igdb_id: an unordered `.range()` here would repeat the exact
 * paging bug measured in seed-external-ids.ts and xbox-title-bridge.ts.
 */
async function catalogIgdbIds(): Promise<{ all: Set<number>; rated: Set<number> }> {
  const all = new Set<number>();
  const rated = new Set<number>();
  let after = 0;
  for (;;) {
    const { data, error } = await admin
      .from("games")
      .select("igdb_id, total_rating_count")
      .not("igdb_id", "is", null)
      .gt("igdb_id", after)
      .order("igdb_id", { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) {
      all.add(r.igdb_id as number);
      if ((r.total_rating_count as number ?? 0) >= 5) rated.add(r.igdb_id as number);
    }
    after = data[data.length - 1].igdb_id as number;
  }
  return { all, rated };
}

async function main() {
  console.log("reading catalog igdb ids...");
  const { all: catalog, rated } = await catalogIgdbIds();
  console.log(`  catalog: ${catalog.size} games, ${rated.size} with >= 5 ratings\n`);

  console.log("reading IGDB external_games for GiantBomb (source 3)...");
  const giantbombGameIds = new Set<number>();
  let after = 0;
  let rows = 0;
  for (;;) {
    const page = await igdbQuery<{ id: number; uid?: string; game?: number }>(
      creds, "external_games",
      `fields uid, game; where external_game_source = ${GIANTBOMB_SOURCE} & id > ${after}; sort id asc; limit 500;`,
    );
    if (page.length === 0) break;
    for (const r of page) if (r.game) giantbombGameIds.add(r.game);
    rows += page.length;
    after = page[page.length - 1].id;
    if (rows % 5000 === 0) process.stdout.write(`\r  ${rows} rows...`);
  }
  console.log(`\r  ${rows} IGDB rows carry a GiantBomb id, ${giantbombGameIds.size} distinct games\n`);

  const pct = (n: number, d: number) => ((n / d) * 100).toFixed(1) + "%";
  const only = (s: Set<number>, f: Set<number>) => [...s].filter((x) => f.has(x)).length;

  const allHit = only(catalog, giantbombGameIds);
  const ratedHit = only(rated, giantbombGameIds);

  console.log(`=== the GiantBomb ceiling for a Grouvee import ===`);
  console.log(`  all ${catalog.size} catalog games`);
  console.log(`    carry a GiantBomb id      ${allHit} = ${pct(allHit, catalog.size)}`);
  console.log(`\n  the ${rated.size} with >= 5 ratings (closer proxy for a tracked library)`);
  console.log(`    carry a GiantBomb id      ${ratedHit} = ${pct(ratedHit, rated.size)}`);
  console.log(`\n  Compare against name matching's measured 97.0% rank-1 (section 2a).`);
  console.log(`  Same call Josh set for Xbox: >70% direct join first, <50% matcher`);
  console.log(`  primary, between the two is a precision layer over the matcher.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
