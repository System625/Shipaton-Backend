// Proves the re-release pass (pass 3 of the seed) against live IGDB BEFORE anyone
// spends three hours re-seeding on it. Read-only: writes nothing, anywhere.
//
// What it is checking, and why each check exists:
//
//  1. `game_type = (4,8,9,10,11)` really is Apicalypse's "equal to any of" on a
//     scalar field. This is the one assumption in the whole change that the repo
//     had no evidence for — the docs describe `= (...)` for arrays, and nothing
//     here had used it on a scalar before. If it silently means something else,
//     the seed would run to completion and quietly write the wrong catalog.
//  2. The union query returns exactly what five separate per-type queries return,
//     no more and no fewer, and every row that comes back is one of the five
//     admitted types.
//  3. What actually came in through the two clauses this pass drops. Written
//     expecting zero editions, on the reasoning that an edition is `game_type = 0`
//     with a `version_parent` and this pass never asks for type 0. It failed on
//     the first run — IGDB types "Deus Ex: Game of the Year Edition" as Expanded
//     Game, not as type 0. 23 such rows, all small, now pinned rather than
//     excluded; seedRereleasePageQuery carries the argument for keeping them.
//  4. The eight games §5 of research/semantic-search.md names — RE2 2019, RE4
//     2023, Persona 5 Royal, Mario Kart 8 Deluxe, The Last of Us Part I, Dark
//     Souls: Remastered, The Last of Us Remastered, Phoenix Wright: Ace Attorney
//     — are each actually admitted. That is the argument for doing this at all,
//     and it is stated in a doc rather than enforced anywhere.
//  5. The 11 Sep measurements still hold: ~2,042 admitted rows and ~510 titles
//     that collide with a row already in the catalog. A large move in either
//     number means IGDB's data shifted under the decision and §5 should be re-read
//     before running the seed, not after.
//
// The counts are asserted as ranges, not equalities. IGDB is a live, edited
// database and these rows gain ratings daily; a row crossing the >= 5 threshold
// is normal drift, a 30% swing is not.

import {
  igdbQuery,
  seedRereleasePageQuery,
  REREL_TYPES,
  type IgdbGame,
} from "../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";
import { makeChecker } from "./social-accounts.ts";

const { check, finish } = makeChecker();
const creds = igdbCreds();

// The floor the seed uses. Matches SEED_MIN_POPULARITY's default; passing a
// different one here would measure a pass nobody is going to run.
const MIN_RATINGS = 5;

// Measured 11 Sep 2026 against live IGDB (research/semantic-search.md §5).
const EXPECTED_ROWS = 2042;
const EXPECTED_COLLISIONS = 510;
const DRIFT = 0.3; // 30% either way before this is a finding rather than drift

/** Walks a paged Apicalypse query to exhaustion. */
async function drain(page: (afterId: number) => string): Promise<IgdbGame[]> {
  const out: IgdbGame[] = [];
  let after = 0;
  for (;;) {
    const rows = await igdbQuery<IgdbGame>(creds, "games", page(after));
    if (rows.length === 0) return out;
    out.push(...rows);
    after = rows[rows.length - 1].id;
  }
}

async function main() {
  console.log("\nSeed widening (pass 3) verification — live IGDB, writes nothing\n");

  // ---- 1. The union query ----
  console.log("1. The union query returns the admitted types and nothing else");
  const union = await drain((afterId) => seedRereleasePageQuery(afterId, MIN_RATINGS));
  check("union query returned rows", union.length > 0, `${union.length} rows`);

  const admitted = new Set<number>(REREL_TYPES);
  const strayTypes = [...new Set(union.map((g) => g.game_type).filter((t) => !admitted.has(t!)))];
  check(
    "every row is one of types 4, 8, 9, 10, 11",
    strayTypes.length === 0,
    strayTypes.length === 0 ? "no strays" : `STRAY TYPES: ${strayTypes.join(", ")}`,
  );

  const underFloor = union.filter((g) => (g.total_rating_count ?? 0) < MIN_RATINGS);
  check(
    `every row clears the >= ${MIN_RATINGS} rating floor`,
    underFloor.length === 0,
    underFloor.length === 0 ? "" : `${underFloor.length} below floor`,
  );

  // ---- 2. The union is exactly the five per-type queries ----
  // This is the check that `= (...)` means what the seed assumes it means. If
  // Apicalypse read it as "all of" rather than "any of", this comes back empty
  // and every count above would still have looked plausible on its own.
  console.log("\n2. `game_type = (4,8,9,10,11)` is IN, not something else");
  const perType = new Map<number, number>();
  const perTypeIds = new Set<number>();
  for (const t of REREL_TYPES) {
    const rows = await drain(
      (afterId) =>
        `fields id,name,game_type,total_rating_count; ` +
        `where id > ${afterId} & game_type = ${t} & total_rating_count >= ${MIN_RATINGS}; ` +
        `sort id asc; limit 500;`,
    );
    perType.set(t, rows.length);
    rows.forEach((r) => perTypeIds.add(r.id));
  }
  console.log(
    `     per type: ${[...perType].map(([t, n]) => `${t}=${n}`).join(", ")}` +
    `  (union ${union.length})`,
  );

  const unionIds = new Set(union.map((g) => g.id));
  const missing = [...perTypeIds].filter((id) => !unionIds.has(id));
  const extra = [...unionIds].filter((id) => !perTypeIds.has(id));
  check("union contains every per-type row", missing.length === 0, `${missing.length} missing`);
  check("union contains nothing the per-type queries do not", extra.length === 0, `${extra.length} extra`);

  // ---- 3. What came in through the dropped clauses ----
  // This check was written asserting ZERO editions, on the reasoning that an
  // edition is game_type 0 + version_parent and this pass never asks for type 0.
  // It failed on the first run: 23 rows carry a version_parent — "Bulletstorm:
  // Full Clip Edition", "Deus Ex: Game of the Year Edition", "Age of Mythology:
  // Extended Edition". IGDB types those as Remaster/Expanded/Port, not as type 0.
  //
  // They are kept (see seedRereleasePageQuery for the argument), so this now pins
  // the measured shape instead of an assumption: a small set, none of them big.
  // If IGDB ever re-types something major into this opening, the ratings ceiling
  // catches it.
  console.log("\n3. What came in through the dropped parent_game / version_parent clauses");
  const withParent = union.filter((g) => g.parent_game != null).length;
  check(
    "every row carries a parent_game — the rows passes 1 and 2 reject",
    withParent === union.length,
    `${withParent} of ${union.length}`,
  );

  const versioned = union.filter((g) => g.version_parent != null);
  const VERSIONED_MAX_ROWS = 50;   // 23 measured 15 Sep
  const VERSIONED_MAX_RATINGS = 150; // top was Bulletstorm: Full Clip Edition at 94
  check(
    `edition rows stay a small tail (<= ${VERSIONED_MAX_ROWS})`,
    versioned.length <= VERSIONED_MAX_ROWS,
    `${versioned.length} carry a version_parent`,
  );
  const bigEdition = versioned
    .filter((g) => (g.total_rating_count ?? 0) >= VERSIONED_MAX_RATINGS)
    .sort((a, b) => (b.total_rating_count ?? 0) - (a.total_rating_count ?? 0));
  check(
    `no edition row is a major title (>= ${VERSIONED_MAX_RATINGS} ratings)`,
    bigEdition.length === 0,
    bigEdition.length === 0
      ? "biggest is " +
        (versioned.length
          ? `"${versioned.reduce((a, b) => ((a.total_rating_count ?? 0) > (b.total_rating_count ?? 0) ? a : b)).name}"`
          : "none")
      : `RE-READ §5: ${bigEdition.slice(0, 3).map((g) => `${g.name} (${g.total_rating_count})`).join(" | ")}`,
  );

  // ---- 4. The eight games the decision was made for ----
  console.log("\n4. The games §5 names are actually admitted");
  const byName = new Map(union.map((g) => [g.name.toLowerCase(), g]));
  const WANTED = [
    "Resident Evil 2",
    "Resident Evil 4",
    "Persona 5 Royal",
    "Mario Kart 8 Deluxe",
    "The Last of Us Part I",
    "Dark Souls: Remastered",
    "The Last of Us Remastered",
    "Phoenix Wright: Ace Attorney",
  ];
  for (const title of WANTED) {
    const hit = byName.get(title.toLowerCase());
    check(
      `admits "${title}"`,
      hit != null,
      hit ? `type ${hit.game_type}, ${hit.total_rating_count ?? 0} ratings` : "NOT IN THE PASS",
    );
  }

  // ---- 5. The 11 Sep numbers still hold ----
  console.log("\n5. The measurements the decision rests on still hold");
  const lo = Math.round(EXPECTED_ROWS * (1 - DRIFT));
  const hi = Math.round(EXPECTED_ROWS * (1 + DRIFT));
  check(
    `admitted rows near the measured ${EXPECTED_ROWS}`,
    union.length >= lo && union.length <= hi,
    `${union.length} (expected ${lo}-${hi})`,
  );

  // Duplicate titles are the entire cost of this decision — 510 of them on
  // 11 Sep. Re-count against the live catalog so the number in the docs is the
  // number that will actually land.
  const names = [...new Set(union.map((g) => g.name))];
  let collisions = 0;
  const examples: string[] = [];
  for (let i = 0; i < names.length; i += 200) {
    const { data, error } = await admin
      .from("games")
      .select("title")
      .in("title", names.slice(i, i + 200));
    if (error) throw new Error(`catalog title lookup failed: ${error.message}`);
    for (const row of (data ?? []) as { title: string }[]) {
      collisions++;
      if (examples.length < 8) examples.push(row.title);
    }
  }
  const cLo = Math.round(EXPECTED_COLLISIONS * (1 - DRIFT));
  const cHi = Math.round(EXPECTED_COLLISIONS * (1 + DRIFT));
  check(
    `duplicate titles near the measured ${EXPECTED_COLLISIONS}`,
    collisions >= cLo && collisions <= cHi,
    `${collisions} (expected ${cLo}-${cHi})`,
  );
  console.log(`     e.g. ${examples.join(" | ")}`);
  console.log(
    `     ${names.length} distinct titles in the pass. Duplicates are accepted on ` +
    `purpose: the ranking's popularity term puts the re-release first (§5).`,
  );

  finish();
}

main();
