const SUPA = process.env.SUPABASE_URL!, SRK = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CID = process.env.TWITCH_CLIENT_ID!, CS = process.env.TWITCH_CLIENT_SECRET!;

async function igdbToken() {
  const r = await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CID}&client_secret=${CS}&grant_type=client_credentials`, { method: "POST" });
  return (await r.json()).access_token as string;
}
let TOKEN = "";
let nextSlot = 0;
async function ig<T>(endpoint: string, body: string): Promise<T[]> {
  const now = Date.now(); const slot = Math.max(now, nextSlot); nextSlot = slot + 260;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  for (let a = 0; a < 5; a++) {
    const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
      method: "POST", headers: { "Client-ID": CID, Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }, body,
    });
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 1000 * (a + 1))); continue; }
    if (!res.ok) throw new Error(`${endpoint} ${res.status} ${await res.text()}`);
    return await res.json();
  }
  throw new Error("429 exhausted");
}

// Pull igdb ids for a platform subset, paging through PostgREST.
async function ids(platformIds: number[]): Promise<number[]> {
  const out: number[] = [];
  for (let from = 0; ; from += 1000) {
    const url = `${SUPA}/rest/v1/games?select=igdb_id,game_platforms!inner(platform_id)&total_rating_count=gte.5&game_platforms.platform_id=in.(${platformIds.join(",")})&igdb_id=not.is.null`;
    const res = await fetch(url, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, Range: `${from}-${from + 999}`, "Range-Unit": "items" } });
    if (!res.ok) throw new Error(`supabase ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as { igdb_id: number }[];
    out.push(...rows.map((r) => r.igdb_id));
    if (rows.length < 1000) break;
  }
  return [...new Set(out)];
}

async function covered(igdbIds: number[], source: number): Promise<Set<number>> {
  const hit = new Set<number>();
  for (let i = 0; i < igdbIds.length; i += 300) {
    const batch = igdbIds.slice(i, i + 300);
    let offset = 0;
    for (;;) {
      const rows = await ig<{ game: number }>("external_games",
        `fields game; where external_game_source = ${source} & game = (${batch.join(",")}); limit 500; offset ${offset};`);
      rows.forEach((r) => hit.add(r.game));
      if (rows.length < 500) break;
      offset += 500;
    }
  }
  return hit;
}

async function main() {
  TOKEN = await igdbToken();
  const sets: [string, number[], [string, number][]][] = [
    ["PC (platform 6), >=5 ratings",        [6],       [["Steam", 1], ["GOG", 5], ["Epic", 26], ["Itch", 30]]],
    ["PlayStation (48 PS4, 167 PS5)",       [48, 167], [["PS Store US (concept id)", 36]]],
    ["Xbox (49 One, 169 Series X|S)",       [49, 169], [["Microsoft (store product id)", 11], ["Xbox Marketplace (360 guid)", 31]]],
    ["Mobile (34 Android, 39 iOS)",         [34, 39],  [["Android (package name)", 15], ["Apple (App Store id)", 13]]],
  ];
  for (const [label, plats, sources] of sets) {
    const list = await ids(plats);
    console.log(`\n## ${label} — ${list.length} catalog games`);
    for (const [name, src] of sources) {
      const hit = await covered(list, src);
      const pct = ((hit.size / list.length) * 100).toFixed(1);
      console.log(`   ${name.padEnd(30)} ${String(hit.size).padStart(6)} / ${list.length}  = ${pct}%`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
