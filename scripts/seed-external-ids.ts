// Seeds game_external_ids: the store-id -> catalog-game map every import needs.
//
// The third seed pass, alongside seed-platforms.ts and seed-games.ts. Run it after
// those two; it resolves against whatever is already in `games`, so seeding it
// against an empty catalog produces an empty table rather than an error.
//
// WHAT MAKES THIS MORE THAN A MIRROR OF IGDB's `external_games`. A straight copy
// resolves 78.1% of a real Steam library (measured 12 Sep, docs/research/
// account-linking.md section 1). The other ~10 points are editions, remasters and
// bundles that our seed excludes on purpose -- `game_type <> 0` is what keeps
// duplicate editions out of search results, and it is the right call there and the
// wrong one here. Somebody who owns "Skyrim Special Edition" owns Skyrim. So every
// id that misses the catalog gets ONE hop through parent_game/version_parent, and
// the edge is written against the parent with via_parent = true.
//
// Cost: ~400 IGDB requests per run at 4 req/sec, so single-digit minutes. Nothing
// here is on a user's critical path -- that is the entire point of the table.

import { igdbQuery } from "../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";
import { pathToFileURL } from "node:url";

const creds = igdbCreds();

// IGDB's external_game_source ids, pulled live 12 Sep and re-checked 14 Sep.
// Only sources whose uid is the SAME STRING the platform's own API returns are
// here. See the check constraint in 20260914100000_game_external_ids.sql for why
// PlayStation is not one of them.
const SOURCES: { name: string; igdbSource: number; note: string }[] = [
  { name: "steam",     igdbSource: 1,  note: "appid, joins exactly to GetOwnedGames" },
  { name: "microsoft", igdbSource: 11, note: "Store product id; NOT the Xbox Live title id" },
  { name: "android",   igdbSource: 15, note: "Play Store package name, joins exactly" },
];

type ExternalRow = { id: number; game?: number; uid?: string };

/**
 * Every igdb_id we hold, mapped to its catalog uuid. One pass, keyset paged.
 *
 * THIS USED `.range(from, from + 999)` WITH NO `.order()`, AND IT SILENTLY READ ABOUT
 * TWO THIRDS OF THE CATALOG. Postgres guarantees no row order without an ORDER BY, so
 * successive OFFSET windows over the same query can skip rows and repeat others. It
 * never errored and it never looked wrong: it printed a large, plausible number and
 * seeded a partial table. Measured 15 Sep against 91,806 eligible rows --
 *
 *     true count:        91806
 *     offset paging, #1: 59879
 *     offset paging, #2: 59212     <- same data, same code, 667 rows apart
 *     keyset paging:     91806
 *
 * -- so roughly a third of the catalog had no store ids written for it, and WHICH
 * third changed every run. Every import that joins through this table was quietly
 * falling back to name matching for those games.
 *
 * Keyset paging on `igdb_id` is stable because it carries its own ordering: each page
 * asks for rows after the last id it saw, so a row cannot be skipped by a shifting
 * window. It is the same thing pullSource() below already does against IGDB, and the
 * reason is the same one stated there.
 *
 * The lesson generalises: a paged read whose page boundary is a COUNT rather than a
 * VALUE is only correct if the order is pinned. `npm run verify:external-id-paging`
 * asserts this one against the true count.
 */
export async function catalogByIgdbId(): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let after = 0;
  for (;;) {
    const { data, error } = await admin
      .from("games")
      .select("id, igdb_id")
      .not("igdb_id", "is", null)
      .gt("igdb_id", after)
      .order("igdb_id", { ascending: true })
      .limit(1000);
    if (error) throw new Error(`games read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) map.set(row.igdb_id as number, row.id as string);
    after = data[data.length - 1].igdb_id as number;
  }
  return map;
}

/**
 * Every external_games row for one source. Pages on ascending row id, not `offset`
 * -- same reason as the games seed, deep offsets degrade badly.
 */
async function pullSource(igdbSource: number): Promise<ExternalRow[]> {
  const out: ExternalRow[] = [];
  let after = 0;
  for (;;) {
    const page = await igdbQuery<ExternalRow>(
      creds,
      "external_games",
      `fields game, uid; where external_game_source = ${igdbSource} & id > ${after}; ` +
      `sort id asc; limit 500;`,
    );
    if (page.length === 0) break;
    out.push(...page);
    after = page[page.length - 1].id;
    if (out.length % 10_000 < 500) process.stdout.write(`\r    pulled ${out.length}`);
  }
  process.stdout.write(`\r    pulled ${out.length}\n`);
  return out;
}

/** parent_game / version_parent for a set of IGDB games, batched. */
async function parentsOf(igdbIds: number[]): Promise<Map<number, number>> {
  const parent = new Map<number, number>();
  for (let i = 0; i < igdbIds.length; i += 300) {
    const batch = igdbIds.slice(i, i + 300);
    const rows = await igdbQuery<{ id: number; parent_game?: number; version_parent?: number }>(
      creds,
      "games",
      `fields id, parent_game, version_parent; where id = (${batch.join(",")}); limit 500;`,
    );
    for (const r of rows) {
      // version_parent first: an *edition* points at the game it is an edition of,
      // which is the more specific relationship. parent_game covers DLC, remasters
      // and standalone expansions.
      const p = r.version_parent ?? r.parent_game;
      if (p) parent.set(r.id, p);
    }
    if (i % 3000 === 0) process.stdout.write(`\r    parents for ${i}/${igdbIds.length}`);
  }
  process.stdout.write(`\r    parents for ${igdbIds.length}/${igdbIds.length}\n`);
  return parent;
}

type Edge = { source: string; uid: string; game_id: string; via_parent: boolean; igdb_id: number };

async function writeEdges(edges: Edge[]): Promise<void> {
  for (let i = 0; i < edges.length; i += 1000) {
    const { error } = await admin
      .from("game_external_ids")
      .upsert(edges.slice(i, i + 1000), { onConflict: "source,uid,game_id" });
    if (error) throw new Error(`game_external_ids upsert failed: ${error.message}`);
    process.stdout.write(`\r    wrote ${Math.min(i + 1000, edges.length)}/${edges.length}`);
  }
  process.stdout.write("\n");
}

async function main() {
  console.log("reading catalog...");
  const catalog = await catalogByIgdbId();
  console.log(`  ${catalog.size} catalog games carry an igdb_id.\n`);

  const only = process.env.SEED_EXTERNAL_SOURCES?.split(",").map((s) => s.trim());
  const summary: string[] = [];

  for (const { name, igdbSource, note } of SOURCES) {
    if (only && !only.includes(name)) continue;
    console.log(`=== ${name} (IGDB source ${igdbSource}) — ${note}`);

    const rows = (await pullSource(igdbSource)).filter(
      (r): r is ExternalRow & { game: number; uid: string } => !!r.game && !!r.uid,
    );

    const direct: Edge[] = [];
    const gap: (ExternalRow & { game: number; uid: string })[] = [];
    for (const r of rows) {
      const gameId = catalog.get(r.game);
      if (gameId) direct.push({ source: name, uid: r.uid, game_id: gameId, via_parent: false, igdb_id: r.game });
      else gap.push(r);
    }

    // One hop, and only one. A parent that is itself missing from the catalog is
    // left alone: chasing grandparents starts collapsing distinct games together,
    // and the measurement that justified the hop only ever measured one.
    const parent = await parentsOf([...new Set(gap.map((r) => r.game))]);
    const hopped: Edge[] = [];
    for (const r of gap) {
      const p = parent.get(r.game);
      const gameId = p ? catalog.get(p) : undefined;
      if (gameId) hopped.push({ source: name, uid: r.uid, game_id: gameId, via_parent: true, igdb_id: r.game });
    }

    const edges = [...direct, ...hopped];
    console.log(`  ${rows.length} external rows -> ${edges.length} edges ` +
      `(${direct.length} direct, ${hopped.length} via parent, ` +
      `${rows.length - edges.length} unresolvable)`);
    await writeEdges(edges);

    const pct = (n: number) => ((n / rows.length) * 100).toFixed(1);
    summary.push(
      `${name.padEnd(10)} ${String(rows.length).padStart(7)} rows  ` +
      `direct ${pct(direct.length).padStart(5)}%  +hop ${pct(edges.length).padStart(5)}%`,
    );
    console.log();
  }

  console.log("done.");
  summary.forEach((s) => console.log("  " + s));
}

// Only when run directly. `catalogByIgdbId` is exported above so that
// verify-external-id-paging.ts can exercise THE REAL FUNCTION rather than a copy of
// it -- a copied paging loop is how the bug it checks for would come back.
const isEntryPoint = process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
