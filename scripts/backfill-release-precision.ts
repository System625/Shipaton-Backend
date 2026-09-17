// Backfills games.release_precision from IGDB, for rows that do not have it yet.
//
//   npx tsx scripts/backfill-release-precision.ts          # the whole catalog
//   npx tsx scripts/backfill-release-precision.ts --limit 2000
//
// A backfill, not a re-seed -- same reasoning as backfill-rating-counts.ts. A
// re-seed rewrites every column on every row (seed-games.ts's own warning: after a
// mapper change, run from zero, never resume) for a change that touches exactly
// one column. This is ~184 requests instead of ~600+, and nothing else can be
// damaged by it.
//
// Only rows with release_date IS NOT NULL need a precision at all -- a null
// release_date is release_tbd's case, already correct, and has nothing to derive
// a precision from. Rows are resumable by construction: it selects only rows still
// missing release_precision, so an interrupted run is restarted by running it again.

import { igdbQuery, releasePrecision, type IgdbGame } from "../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";

const creds = igdbCreds();

const REQUEST_SPACING_MS = 260;
const BATCH = 500;

const limitArg = process.argv.indexOf("--limit");
const maxRows = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every igdb_id with a release_date but no release_precision yet. */
async function idsToBackfill(): Promise<number[]> {
  const ids: number[] = [];
  const PAGE = 1000;
  for (let from = 0; ids.length < maxRows; from += PAGE) {
    const { data, error } = await admin
      .from("games")
      .select("igdb_id")
      .is("release_precision", null)
      .not("release_date", "is", null)
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

const ids = await idsToBackfill();
if (ids.length === 0) {
  console.log("nothing to do — every dated row already has a release_precision.");
  process.exit(0);
}

const batches = Math.ceil(ids.length / BATCH);
console.log(
  `${ids.length} rows to backfill, ${batches} IGDB requests ` +
  `(~${Math.round((batches * REQUEST_SPACING_MS) / 1000)}s at 4 req/sec)\n`,
);

let written = 0;
const byPrecision = new Map<string, number>();
const unresolved: number[] = []; // has a date, but no release_dates row matched it
const vanished: number[] = []; // ids IGDB no longer returns a row for

type ReleaseDateFields = Pick<IgdbGame, "id" | "first_release_date" | "release_dates">;

for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  const started = Date.now();

  const rows = await igdbQuery<ReleaseDateFields>(
    creds,
    "games",
    `fields id, first_release_date, release_dates.date, release_dates.date_format; ` +
      `where id = (${chunk.join(",")}); limit ${BATCH};`,
  );

  const seen = new Set(rows.map((r) => r.id));
  for (const id of chunk) if (!seen.has(id)) vanished.push(id);

  const payload: { igdb_id: number; precision: string | null }[] = [];
  for (const r of rows) {
    const precision = releasePrecision(r as IgdbGame);
    if (precision == null) unresolved.push(r.id);
    else byPrecision.set(precision, (byPrecision.get(precision) ?? 0) + 1);
    payload.push({ igdb_id: r.id, precision });
  }

  if (payload.length > 0) {
    const { data, error } = await admin.rpc("shelf_set_release_precision", { p: payload });
    if (error) throw new Error(`write failed on batch ${i / BATCH + 1}: ${error.message}`);
    written += (data as number) ?? 0;
  }

  const done = Math.min(i + BATCH, ids.length);
  console.log(
    `  ${String(done).padStart(6)}/${ids.length}  written ${String(written).padStart(6)}` +
    `  ${[...byPrecision.entries()].map(([k, v]) => `${k} ${v}`).join(" ")}` +
    `  unresolved ${unresolved.length}  missing ${vanished.length}`,
  );

  const elapsed = Date.now() - started;
  if (elapsed < REQUEST_SPACING_MS) await sleep(REQUEST_SPACING_MS - elapsed);
}

console.log(`\ndone. ${written} rows written.`);
for (const [k, v] of byPrecision) console.log(`  ${k}: ${v}`);
if (unresolved.length > 0) {
  console.log(
    `  ${unresolved.length} had a first_release_date but no matching release_dates row ` +
    `(written NULL): ${unresolved.slice(0, 10).join(", ")}` + (unresolved.length > 10 ? ", …" : ""),
  );
}
if (vanished.length > 0) {
  console.log(
    `  ${vanished.length} igdb_ids returned no row and stay NULL ` +
    `(deleted or merged upstream): ${vanished.slice(0, 10).join(", ")}` +
    (vanished.length > 10 ? ", …" : ""),
  );
}
