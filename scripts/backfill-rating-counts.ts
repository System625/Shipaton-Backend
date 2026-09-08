// Backfills games.total_rating_count from IGDB, for rows that do not have it yet.
//
//   npx tsx scripts/backfill-rating-counts.ts          # the whole catalog
//   npx tsx scripts/backfill-rating-counts.ts --limit 2000
//
// WHY A BACKFILL AND NOT A RE-SEED. STATUS section 4b frames this as "a migration
// plus a re-seed". A re-seed is both more work and more risk: seed-games.ts warns
// that after a code change both passes must be re-run from zero and never resumed,
// and that run is ~400 IGDB requests that rewrites every column on every row --
// which is how the first seed lost 6 rows to corrupt time-to-beat values.
//
// We already hold `igdb_id` for all 89,117 rows and IGDB batch-fetches by id 500 at
// a time (`timeToBeatQuery` is the existing precedent), so the whole catalog is
// ~179 requests that touch exactly one column. Nothing else can be damaged by it.
//
// RESUMABLE BY CONSTRUCTION. It selects only rows where total_rating_count IS NULL,
// so an interrupted run is restarted by running it again -- no cursor, no env var
// to set, and no way for a restart to redo finished work. This is the opposite of
// the seed's resume story and it is deliberate.

import { igdbQuery } from "../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";

const creds = igdbCreds();

// IGDB's documented ceiling is 4 requests/second. The seed runs at the same spacing.
const REQUEST_SPACING_MS = 260;
// IGDB's hard maximum page size, and the size timeToBeatQuery already uses.
const BATCH = 500;

const limitArg = process.argv.indexOf("--limit");
const maxRows = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every igdb_id still missing a count. PostgREST caps a page at 1000 rows. */
async function idsToBackfill(): Promise<number[]> {
  const ids: number[] = [];
  const PAGE = 1000;
  for (let from = 0; ids.length < maxRows; from += PAGE) {
    const { data, error } = await admin
      .from("games")
      .select("igdb_id")
      .is("total_rating_count", null)
      .not("igdb_id", "is", null)
      .order("igdb_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`reading igdb_ids failed: ${error.message}`);
    if (!data || data.length === 0) break;
    ids.push(...data.map((r) => r.igdb_id as number));
    if (data.length < PAGE) break;
  }
  return ids.slice(0, maxRows === Infinity ? undefined : maxRows);
}

type RatingRow = { id: number; total_rating_count?: number };

const ids = await idsToBackfill();
if (ids.length === 0) {
  console.log("nothing to do — every row already has a total_rating_count.");
  process.exit(0);
}

const batches = Math.ceil(ids.length / BATCH);
console.log(
  `${ids.length} rows to backfill, ${batches} IGDB requests ` +
  `(~${Math.round((batches * REQUEST_SPACING_MS) / 1000)}s at 4 req/sec)\n`,
);

let written = 0;
let rated = 0;      // rows IGDB gave an actual count for
let zero = 0;       // rows where IGDB omitted the field, meaning no user ratings
const vanished: number[] = []; // ids IGDB no longer returns a row for

for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  const started = Date.now();

  const rows = await igdbQuery<RatingRow>(
    creds,
    "games",
    `fields id, total_rating_count; where id = (${chunk.join(",")}); limit ${BATCH};`,
  );

  const seen = new Set(rows.map((r) => r.id));
  for (const id of chunk) if (!seen.has(id)) vanished.push(id);

  // IGDB OMITS total_rating_count rather than returning 0, so an absent field is
  // the positive fact "this game has no user ratings" and is stored as 0. Only an
  // id IGDB returns no row for is left NULL, which is why those are counted apart.
  const payload = rows.map((r) => {
    const count = r.total_rating_count ?? 0;
    if (count > 0) rated++; else zero++;
    return { igdb_id: r.id, count };
  });

  if (payload.length > 0) {
    const { data, error } = await admin.rpc("shelf_set_rating_counts", { p: payload });
    if (error) throw new Error(`write failed on batch ${i / BATCH + 1}: ${error.message}`);
    written += (data as number) ?? 0;
  }

  const done = Math.min(i + BATCH, ids.length);
  console.log(
    `  ${String(done).padStart(6)}/${ids.length}  written ${String(written).padStart(6)}` +
    `  rated ${rated}  zero ${zero}  missing ${vanished.length}`,
  );

  const elapsed = Date.now() - started;
  if (elapsed < REQUEST_SPACING_MS) await sleep(REQUEST_SPACING_MS - elapsed);
}

console.log(`\ndone. ${written} rows written.`);
console.log(`  ${rated} have at least one user rating`);
console.log(`  ${zero} have none (IGDB omitted the field)`);
if (vanished.length > 0) {
  console.log(
    `  ${vanished.length} igdb_ids returned no row and stay NULL ` +
    `(deleted or merged upstream): ${vanished.slice(0, 10).join(", ")}` +
    (vanished.length > 10 ? ", …" : ""),
  );
}
