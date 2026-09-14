// What does admitting remakes/remasters/ports/expanded editions actually add,
// and what duplicate titles does it create? Read-only; writes nothing.
import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { admin } from "../supabase-admin.ts";
const creds = igdbCreds();

// 8 Remake, 9 Remaster, 10 Expanded Game, 11 Port, 4 Standalone Expansion.
// Deliberately NOT 2 Expansion (needs the base game), 3 Bundle, 1 DLC.
const ADMIT = [8, 9, 10, 11, 4];

async function main() {
  const rows: any[] = [];
  for (const t of ADMIT) {
    let after = 0;
    while (true) {
      const page = await igdbQuery<any>(creds, "games",
        `fields id,name,game_type,total_rating_count,first_release_date;
         where id > ${after} & game_type = ${t} & total_rating_count >= 5;
         sort id asc; limit 500;`);
      if (!page.length) break;
      rows.push(...page);
      after = page[page.length - 1].id;
    }
  }
  console.log(`candidate rows (types ${ADMIT.join(",")}, >=5 ratings): ${rows.length}`);

  // How many of these titles ALREADY exist in the catalog under a different row?
  const names = [...new Set(rows.map((r) => r.name))];
  let collide = 0;
  const examples: string[] = [];
  for (let i = 0; i < names.length; i += 200) {
    const chunk = names.slice(i, i + 200);
    const { data } = await admin.from("games").select("title").in("title", chunk);
    for (const d of (data ?? []) as any[]) {
      collide++;
      if (examples.length < 15) examples.push(d.title);
    }
  }
  console.log(`distinct candidate titles: ${names.length}`);
  console.log(`titles that EXACTLY match an existing catalog row: ${collide}`);
  console.log(`  e.g. ${examples.join(" | ")}`);

  const byType: Record<number, number> = {};
  for (const r of rows) byType[r.game_type] = (byType[r.game_type] ?? 0) + 1;
  console.log(`\nby type: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}`);
}
main();
