// Backfill SteamSpy crowd tags onto search_lab_docs. 1 req/sec is SteamSpy's
// documented limit for appdetails.
//
// Writes with .update(), NOT .upsert(): Postgres evaluates NOT NULL on the proposed
// tuple BEFORE `on conflict do update`, so a partial upsert payload that omits
// `name` fails every batch — silently, because the counters here track fetches.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const DATA = dirname(fileURLToPath(import.meta.url));

import { admin } from "../supabase-admin.ts";
import { appendFileSync } from "node:fs";

const OUT = join(DATA, "steamtags.jsonl");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { data, error } = await admin
    .from("search_lab_docs").select("igdb_id, steam_appid")
    .not("steam_appid", "is", null).is("steam_tags", null)
    .order("ratings", { ascending: false }).limit(1000);
  if (error) { console.error(error.message); process.exit(1); }
  const todo = data ?? [];
  console.log(`${todo.length} to fetch`);

  let tagged = 0, empty = 0, fail = 0, written = 0;
  for (let i = 0; i < todo.length; i++) {
    const { igdb_id, steam_appid } = todo[i] as any;
    let tags: string[] = [];
    try {
      const res = await fetch(`https://steamspy.com/api.php?request=appdetails&appid=${steam_appid}`,
        { signal: AbortSignal.timeout(20000) });
      const j: any = await res.json();
      const t = j?.tags;
      tags = t && !Array.isArray(t) ? Object.keys(t) : [];
      tags.length ? tagged++ : empty++;
    } catch { fail++; }
    appendFileSync(OUT, JSON.stringify({ igdb_id, steam_appid, tags }) + "\n");
    const { error: e } = await admin.from("search_lab_docs")
      .update({ steam_tags: tags }).eq("igdb_id", igdb_id);
    if (e) console.error(`update ${igdb_id}: ${e.message}`); else written++;
    if ((i + 1) % 100 === 0) console.log(`[${i + 1}/${todo.length}] tagged=${tagged} empty=${empty} failed=${fail} written=${written}`);
    await sleep(1020);
  }
  console.log(`DONE tagged=${tagged} empty=${empty} failed=${fail} written=${written}`);
}
main();
