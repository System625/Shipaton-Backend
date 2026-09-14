import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const DATA = dirname(fileURLToPath(import.meta.url));

import { admin } from "../supabase-admin.ts";
import { readFileSync } from "node:fs";

const lines = readFileSync(join(DATA, "enrichment-sample.tsv"), "utf8").trim().split("\n");
async function main() {
  let ok = 0; const missing: string[] = [];
  for (const l of lines) {
    const [name, text] = l.split("\t");
    const { data, error } = await admin.from("search_lab_docs")
      .update({ enrichment: text }).eq("name", name).select("igdb_id");
    if (error) { console.error(name, error.message); continue; }
    if (!data?.length) missing.push(name); else ok += data.length;
  }
  console.log(`enriched ${ok} rows; ${missing.length} names not matched`);
  if (missing.length) console.log("unmatched:", missing.join(" | "));
}
main();
