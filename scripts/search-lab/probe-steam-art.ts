// Do Steam's art assets actually exist for our games, or only the famous ones?
// HEAD requests against the store-asset CDN. Read-only.
import { admin } from "../supabase-admin.ts";

const ASSETS = ["header.jpg", "library_600x900.jpg", "logo.png", "capsule_616x353.jpg"];
const BASE = "https://shared.steamstatic.com/store_item_assets/steam/apps";

async function main() {
  const { data } = await admin.from("search_lab_docs")
    .select("name, steam_appid, ratings").not("steam_appid", "is", null)
    .order("ratings", { ascending: false }).limit(250);
  const games = data ?? [];
  const found: Record<string, number> = Object.fromEntries(ASSETS.map((a) => [a, 0]));
  let allFour = 0;

  for (let i = 0; i < games.length; i += 25) {
    await Promise.all(games.slice(i, i + 25).map(async (g: any) => {
      const hits = await Promise.all(ASSETS.map(async (a) => {
        try {
          const r = await fetch(`${BASE}/${g.steam_appid}/${a}`,
            { method: "HEAD", signal: AbortSignal.timeout(15000) });
          return r.ok;
        } catch { return false; }
      }));
      hits.forEach((ok, j) => { if (ok) found[ASSETS[j]]++; });
      if (hits.every(Boolean)) allFour++;
    }));
  }

  const pct = (n: number) => `${n}/${games.length} = ${(n / games.length * 100).toFixed(0)}%`;
  console.log(`sampled ${games.length} Steam-mapped games, most-rated first\n`);
  for (const a of ASSETS) console.log(`  ${a.padEnd(22)} ${pct(found[a])}`);
  console.log(`\n  all four present       ${pct(allFour)}`);
}
main();
