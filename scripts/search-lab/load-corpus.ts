import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const DATA = dirname(fileURLToPath(import.meta.url));

import { admin } from "../supabase-admin.ts";
import { readFileSync } from "node:fs";

const rows = readFileSync(join(DATA, "corpus.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
async function main() {
  for (let i = 0; i < rows.length; i += 500) {
    const page = rows.slice(i, i + 500);
    const { error } = await admin.from("search_lab_docs").upsert(page, { onConflict: "igdb_id" });
    if (error) { console.error(i, error.message); process.exit(1); }
    process.stdout.write(`${i + page.length} `);
  }
  const { count } = await admin.from("search_lab_docs").select("*", { count: "exact", head: true });
  console.log(`\nloaded ${count}`);
}
main();
