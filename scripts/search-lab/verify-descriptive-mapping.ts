// Proves the new descriptive columns survive the real IGDB round trip: real query,
// real mapper, real field names. Read-only — writes nothing to the database.
import { igdbQuery, searchGamesQuery, type IgdbGame } from "../../supabase/functions/_shared/igdb.ts";
import { mapIgdbGame } from "../../supabase/functions/_shared/mapping.ts";
import { igdbCreds } from "../env.ts";
const creds = igdbCreds();

async function main() {
  let failures = 0;
  for (const title of ["Sekiro: Shadows Die Twice", "Hollow Knight", "Stardew Valley"]) {
    const rows = await igdbQuery<IgdbGame>(creds, "games", searchGamesQuery(title, 1));
    const g = rows[0];
    if (!g) { console.log(`FAIL  ${title}: no IGDB row`); failures++; continue; }
    const m = mapIgdbGame(g, undefined);
    const ok = typeof m.summary === "string" && m.summary.length > 20
      && Array.isArray(m.themes) && Array.isArray(m.perspectives) && Array.isArray(m.keywords);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${m.title}`);
    console.log(`        summary      ${m.summary ? `${m.summary.length} chars: "${m.summary.slice(0, 70)}…"` : "(null)"}`);
    console.log(`        storyline    ${m.storyline ? `${m.storyline.length} chars` : "(null)"}`);
    console.log(`        themes       ${m.themes.join(", ") || "(none)"}`);
    console.log(`        perspectives ${m.perspectives.join(", ") || "(none)"}`);
    console.log(`        keywords     ${m.keywords.length} -> ${m.keywords.slice(0, 6).join(", ")}`);
    console.log(`        session_fit  ${m.session_fit}  (unchanged behaviour)`);
  }
  console.log(failures ? `\n${failures} FAILED` : `\nall passed`);
  process.exit(failures ? 1 : 0);
}
main();
