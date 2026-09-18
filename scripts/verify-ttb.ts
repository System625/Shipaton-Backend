// Proves the time-to-beat ordering guard holds, in both places it has to.
//
//   npx tsx scripts/verify-ttb.ts        (npm run verify:ttb)
//
// Two halves, and BOTH are needed. §1 tests guardTtbOrder() -- the mapper, which
// keeps future seeds clean. §2 tests the live catalog -- the backfill in
// 20260918110000_ttb_monotonicity.sql, which cleaned what was already written. A
// guard with no backfill leaves the bad rows on screen; a backfill with no guard is
// undone by the next re-seed. This script fails if either half is missing.
//
// §1 calls the real mapper via the real IGDB shapes rather than reimplementing the
// comparison -- a check that tests its own copy of the rule proves nothing about what
// the seed writes (see docs/STATUS.md on verify-igdb.ts's check 3, which made exactly
// that mistake).

import { guardTtbOrder } from "../supabase/functions/_shared/mapping.ts";
import { admin } from "./supabase-admin.ts";

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// 1. The mapper guard, against real rows measured on 18 Sep 2026.
// ---------------------------------------------------------------------------
console.log("\n=== 1. guardTtbOrder() on real catalog values ===");

const cleared: [string, number | null, number | null, number | null][] = [
  ["Grand Theft Auto: Vice City", 876.0, 134.6, 181.8], // the row that started this
  ["Overwatch", 3.0, 810.5, 25.0],
  ["Super Mario Bros.", 2.5, 12.4, 2.1],
  ["Fallout 2", 2.0, 39.0, 15.0],
  ["Crysis", 5.1, 11.2, 5.1],
  ["Metal Gear Solid", 22.0, 12.2, null], // a missing `completely` must not save it
];

for (const [title, hastily, normally, completely] of cleared) {
  const out = guardTtbOrder({ hastily, normally, completely, count: 13 });
  check(
    out.hastily === null && out.normally === null &&
    out.completely === null && out.count === null,
    `cleared: ${title}`,
    `${hastily}/${normally}/${completely} -> ${out.hastily}/${out.normally}/${out.completely}`,
  );
}

// Crowd medians disagreeing in the last digit. These must survive -- a strict `<=`
// would throw all of them away, which is the whole reason for the 25% tolerance.
const kept: [string, number | null, number | null, number | null][] = [
  ["Wolfenstein: The New Order", 13.0, 12.2, 24.8],
  ["Call of Duty 4: Modern Warfare", 9.3, 9.0, 18.0],
  ["The Last of Us Part I", 19.5, 19.0, 21.1],
  ["Grand Theft Auto IV", 30.0, 54.7, 50.0],
  ["Grand Theft Auto: San Andreas", 7.3, 34.0, 31.4],
  ["Metro 2033", 10.6, 10.3, 27.3],
];

for (const [title, hastily, normally, completely] of kept) {
  const out = guardTtbOrder({ hastily, normally, completely, count: 13 });
  check(out.normally === normally, `kept: ${title}`, `normally ${out.normally}`);
}

// Absence is the normal case, not a contradiction: most games carry no entry at all,
// and ~64% of those that do have no `completely`.
const sparse = guardTtbOrder({ hastily: null, normally: 12.0, completely: null, count: 4 });
check(sparse.normally === 12.0, "a lone `normally` with no siblings survives");

const empty = guardTtbOrder({ hastily: null, normally: null, completely: null, count: null });
check(empty.normally === null, "an all-null triple is not an error");

// A zero or negative reading cannot be divided by, and is not a real measurement.
const zero = guardTtbOrder({ hastily: 5.0, normally: 0, completely: 10.0, count: 2 });
check(zero.normally === null, "a zero reading clears the triple rather than dividing by it");

// ---------------------------------------------------------------------------
// 2. The live catalog, after the backfill.
// ---------------------------------------------------------------------------
console.log("\n=== 2. the live catalog ===");

// Paged deliberately with an explicit .order(): an unordered .range() reads a
// different slice each run and would report "clean" off a partial scan. See
// docs/STATUS.md and the postgrest paging note.
type Row = {
  title: string;
  ttb_hastily_hours: number | null;
  ttb_normally_hours: number | null;
  ttb_completely_hours: number | null;
};

const PAGE = 1000;
const offenders: string[] = [];
let scanned = 0;

for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin
    .from("games")
    .select("id, title, ttb_hastily_hours, ttb_normally_hours, ttb_completely_hours")
    .or("ttb_hastily_hours.not.is.null,ttb_normally_hours.not.is.null,ttb_completely_hours.not.is.null")
    .order("id", { ascending: true })
    .range(from, from + PAGE - 1);

  if (error) throw new Error(`catalog read failed: ${error.message}`);
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) break;
  scanned += rows.length;

  for (const r of rows) {
    const h = r.ttb_hastily_hours == null ? null : Number(r.ttb_hastily_hours);
    const n = r.ttb_normally_hours == null ? null : Number(r.ttb_normally_hours);
    const c = r.ttb_completely_hours == null ? null : Number(r.ttb_completely_hours);
    const same = guardTtbOrder({ hastily: h, normally: n, completely: c, count: null });
    if (same.normally !== n || same.hastily !== h || same.completely !== c) {
      offenders.push(`${r.title} (${h}/${n}/${c})`);
    }
  }
  if (rows.length < PAGE) break;
}

console.log(`  scanned ${scanned} rows carrying a time-to-beat`);
check(offenders.length === 0, "no stored triple contradicts itself",
  offenders.length ? `${offenders.length} left: ${offenders.slice(0, 5).join(", ")}` : "");

// The one that was on screen. A targeted assertion, so a future re-seed that loses
// the guard fails here by name rather than in aggregate.
//
// Pinned by igdb_id, NOT by title: the catalog holds two rows called "Grand Theft
// Auto: Vice City" -- the 2002 original (igdb 733, game_type 0) and a 2013 port
// (igdb 215550, game_type 11) admitted by the re-release pass added 15 Sep. That is
// working as designed, and it is why an .eq("title", ...).maybeSingle() here throws
// "multiple (or no) rows returned" rather than checking anything.
const { data: vc, error: vcError } = await admin
  .from("games")
  .select("title, ttb_normally_hours, ttb_count")
  .eq("igdb_id", 733)
  .maybeSingle();
if (vcError) throw new Error(vcError.message);
check(
  vc != null && vc.ttb_normally_hours == null && vc.ttb_count == null,
  "Grand Theft Auto: Vice City no longer reports a time to beat",
  vc ? `normally=${vc.ttb_normally_hours} count=${vc.ttb_count}` : "row missing",
);

// ---------------------------------------------------------------------------
// Context, not an assertion: the guard cannot fix a number nobody corroborated.
// ---------------------------------------------------------------------------
const { count: withValue } = await admin
  .from("games").select("id", { count: "exact", head: true })
  .not("ttb_normally_hours", "is", null);
const { count: singleSubmission } = await admin
  .from("games").select("id", { count: "exact", head: true })
  .not("ttb_normally_hours", "is", null).eq("ttb_count", 1);

console.log(
  `\n  NOTE: ${singleSubmission} of ${withValue} surviving values rest on ONE submission ` +
  `(${((100 * (singleSubmission ?? 0)) / (withValue || 1)).toFixed(1)}%). ` +
  `Not a defect this script can catch — see docs/research/quick-view-card.md §7.`,
);

console.log(failures === 0 ? "\nAll time-to-beat checks passed.\n" : `\n${failures} CHECK(S) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
