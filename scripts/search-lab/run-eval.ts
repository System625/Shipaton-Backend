// Score an eval set against whatever retrieval function is currently wired up.
//
//   npx tsx scripts/search-lab/run-eval.ts reddit-eval.tsv
//   npx tsx scripts/search-lab/run-eval.ts vibe-eval.tsv --verbose
//
// Reports recall@1 and recall@5 over only the queries whose gold answer is present
// in the corpus — you cannot retrieve what you do not hold, and mixing the two
// failures together hides which one you actually have.
import { admin } from "../supabase-admin.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ?? "reddit-eval.tsv";
const verbose = process.argv.includes("--verbose");

// Sentinels, not answers: one query has no correct game, one names a game the
// catalog has never held. Both are excluded from scoring on purpose.
const NOT_SCORED = new Set(["distractor-none", "Backbone"]);

const rows = readFileSync(join(here, file), "utf8").trim().split("\n").slice(1)
  .map((l) => { const [query, gold] = l.split("\t"); return { query, gold }; })
  .filter((r) => r.query && !NOT_SCORED.has(r.gold));

async function main() {
  const { data: present, error } = await admin.from("search_lab_docs")
    .select("name").in("name", [...new Set(rows.map((r) => r.gold))]);
  if (error) { console.error(error.message); process.exit(1); }
  const have = new Set((present ?? []).map((p: any) => p.name));
  const answerable = rows.filter((r) => have.has(r.gold));

  let hit1 = 0, hit5 = 0;
  const misses: string[] = [];
  for (const r of answerable) {
    const { data } = await admin.rpc("shelf_lab_search", { q: r.query, n: 5 });
    const names: string[] = (data ?? []).map((d: any) => d.name);
    if (names[0] === r.gold) hit1++;
    if (names.includes(r.gold)) hit5++;
    else misses.push(`  want ${r.gold}\n    q: ${r.query.slice(0, 90)}\n    got: ${names.join(" | ") || "(nothing)"}`);
  }

  const pct = (n: number) => `${n}/${answerable.length} = ${(n / answerable.length * 100).toFixed(0)}%`;
  console.log(`=== ${file} ===`);
  console.log(`queries scored:  ${answerable.length} of ${rows.length}`);
  console.log(`gold in corpus:  ${answerable.length}/${rows.length} (${(answerable.length / rows.length * 100).toFixed(0)}%) — this is the ceiling`);
  console.log(`recall@1:        ${pct(hit1)}`);
  console.log(`recall@5:        ${pct(hit5)}`);
  const absent = [...new Set(rows.filter((r) => !have.has(r.gold)).map((r) => r.gold))];
  if (absent.length) console.log(`\nnot in corpus (${absent.length}): ${absent.join(", ")}`);
  if (verbose && misses.length) console.log(`\n--- misses ---\n${misses.join("\n")}`);
}
main();
