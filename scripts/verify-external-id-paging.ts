// Guards one bug, in the one place it cannot be seen.
//
// seed-external-ids.ts read the catalog with `.range(from, from + 999)` and no
// `.order()`. Postgres does not promise a row order without ORDER BY, so successive
// OFFSET windows skipped rows and repeated others: the seed read ~60k of 91,806
// games, a DIFFERENT ~60k each run, and reported success. Nothing errored, nothing
// looked wrong, and every platform import silently lost the direct-join path for
// about a third of the catalog.
//
// It is untestable from the outside -- a partial map produces a smaller table, not a
// broken one -- so this asserts the only thing that distinguishes them: the read must
// return EVERY eligible row, and it must return the same rows twice running.
//
// Imports the real function from the seed script rather than reimplementing the loop.
// Read only.

import { catalogByIgdbId } from "./seed-external-ids.ts";
import { admin } from "./supabase-admin.ts";
import { makeChecker } from "./social-accounts.ts";

const { check, finish } = makeChecker();

async function main() {
  console.log("\nCatalog paging verification (seed-external-ids)\n");

  const { count, error } = await admin
    .from("games")
    .select("*", { count: "exact", head: true })
    .not("igdb_id", "is", null);
  if (error) throw new Error(`count failed: ${error.message}`);
  const trueCount = count ?? 0;
  console.log(`  catalog rows carrying an igdb_id: ${trueCount}\n`);

  const first = await catalogByIgdbId();
  check("the paged read returns every eligible row", first.size === trueCount,
    `${first.size} of ${trueCount}`);

  // The failure mode was non-deterministic, so one pass could pass by luck. Two
  // passes disagreeing is the signature of an unordered OFFSET window and is what
  // the original bug actually looked like (59,879 then 59,212).
  const second = await catalogByIgdbId();
  check("and returns the same rows on a second pass", second.size === first.size,
    `${first.size} then ${second.size}`);

  const drifted = [...first.keys()].filter((k) => !second.has(k));
  check("no row present in one pass and missing from the other", drifted.length === 0,
    drifted.length === 0 ? "identical sets" : `${drifted.length} differ, e.g. igdb_id ${drifted[0]}`);

  finish();
}

main();
