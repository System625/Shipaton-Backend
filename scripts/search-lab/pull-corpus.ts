// Pull descriptive text for the top-N rated IGDB games into a local JSONL file.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const DATA = dirname(fileURLToPath(import.meta.url));

import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { writeFileSync, appendFileSync } from "node:fs";

const creds = igdbCreds();
const OUT = join(DATA, "corpus.jsonl");
const FIELDS =
  "fields id,name,summary,storyline,themes.name,keywords.name,genres.name," +
  "player_perspectives.name,game_modes.name,total_rating_count,first_release_date," +
  "external_games.uid,external_games.external_game_source;";

async function main() {
  writeFileSync(OUT, "");
  let after = 0, total = 0;
  // Every game with >=20 ratings, any type (so remakes/ports are included on purpose).
  while (true) {
    const rows = await igdbQuery<any>(creds, "games",
      `${FIELDS} where id > ${after} & total_rating_count >= 20; sort id asc; limit 500;`);
    if (!rows.length) break;
    for (const g of rows) {
      const steam = (g.external_games ?? []).find((e: any) => e.external_game_source === 1)?.uid ?? null;
      appendFileSync(OUT, JSON.stringify({
        igdb_id: g.id, name: g.name,
        summary: g.summary ?? null, storyline: g.storyline ?? null,
        themes: (g.themes ?? []).map((x: any) => x.name),
        genres: (g.genres ?? []).map((x: any) => x.name),
        keywords: (g.keywords ?? []).map((x: any) => x.name),
        perspectives: (g.player_perspectives ?? []).map((x: any) => x.name),
        modes: (g.game_modes ?? []).map((x: any) => x.name),
        ratings: g.total_rating_count ?? 0,
        year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
        steam_appid: steam,
      }) + "\n");
    }
    after = rows[rows.length - 1].id;
    total += rows.length;
    if (total % 2000 === 0) console.log(`  ${total}…`);
  }
  console.log(`done: ${total} games -> ${OUT}`);
}
main();
