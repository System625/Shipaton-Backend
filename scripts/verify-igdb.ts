// Proves the Twitch credentials in .env actually reach IGDB, before the seed runs.
//
//   npx tsx scripts/verify-igdb.ts
//
// Checks four things in order, so a failure tells you which one broke:
//   1. Twitch issues an app access token for the client id/secret
//   2. IGDB accepts that token on a real query
//   3. the game_type filter is doing its job
//   4. game_time_to_beats returns seconds, which is what the mapping divides by

import { igdbQuery, GAME_FIELDS, type IgdbGame, type IgdbTimeToBeat } from
  "../supabase/functions/_shared/igdb.ts";
import { mapIgdbGame } from "../supabase/functions/_shared/mapping.ts";
import { igdbCreds } from "./env.ts";

const creds = igdbCreds();
console.log(`client id ${creds.clientId.slice(0, 6)}… (secret ${creds.clientSecret.length} chars)\n`);

// 1 + 2: a token is fetched lazily by the first query, so this covers both.
const games = await igdbQuery<IgdbGame>(
  creds,
  "games",
  `${GAME_FIELDS} search "elden ring"; where game_type = 0; limit 5;`,
);
console.log(`authenticated. "elden ring" -> ${games.length} main games:`);
for (const g of games) {
  console.log(`  ${String(g.id).padEnd(8)} ${g.name}`);
}

// 3: nothing here should be DLC, a bundle or an edition.
const polluted = games.filter(
  (g) => g.game_type !== 0 || g.parent_game != null || g.version_parent != null,
);
console.log(
  polluted.length === 0
    ? "\ngame_type filter clean — no DLC, bundles or editions"
    : `\nWARNING: ${polluted.length} non-main rows got through: ${polluted.map((g) => g.name).join(", ")}`,
);

// 4: seconds, not hours. If this ever changes, every ttb_*_hours column is wrong.
const first = games[0];
if (first) {
  const ttbs = await igdbQuery<IgdbTimeToBeat>(
    creds,
    "game_time_to_beats",
    `fields game_id, hastily, normally, completely, count; where game_id = ${first.id};`,
  );
  const ttb = ttbs[0];
  if (!ttb) {
    console.log(`\nno time-to-beat entry for ${first.name} (normal — not every game has one)`);
  } else {
    console.log(`\ntime to beat, raw seconds: ${JSON.stringify(ttb)}`);
    const mapped = mapIgdbGame(first, ttb);
    console.log(
      `mapped: ${mapped.title} — hastily ${mapped.ttb_hastily_hours}h, ` +
      `normally ${mapped.ttb_normally_hours}h, completely ${mapped.ttb_completely_hours}h ` +
      `(${mapped.ttb_count} submissions), session_fit ${mapped.session_fit}`,
    );
    if ((mapped.ttb_normally_hours ?? 0) > 500) {
      console.log("WARNING: that looks like milliseconds, not seconds. Check the divisor.");
    }
  }
}

console.log("\nIGDB credentials are good.");
