const SUPA = process.env.SUPABASE_URL!, SRK = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CID = process.env.TWITCH_CLIENT_ID!, CS = process.env.TWITCH_CLIENT_SECRET!;
let TOKEN = "", nextSlot = 0;
async function ig<T>(e: string, b: string): Promise<T[]> {
  const now = Date.now(); const slot = Math.max(now, nextSlot); nextSlot = slot + 260;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  const res = await fetch(`https://api.igdb.com/v4/${e}`, { method: "POST", headers: { "Client-ID": CID, Authorization: `Bearer ${TOKEN}`, Accept: "application/json" }, body: b });
  if (!res.ok) throw new Error(`${e} ${res.status} ${await res.text()}`);
  return await res.json();
}
async function main() {
  TOKEN = await (await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CID}&client_secret=${CS}&grant_type=client_credentials`, { method: "POST" })).json().then((j: any) => j.access_token);
  const types = await ig<{ id: number; type: string }>("game_types", "fields id,type; limit 50;");
  const typeName = new Map(types.map((t) => [t.id, t.type]));
  console.log("IGDB game_types:", types.map((t) => `${t.id}=${t.type}`).join(", "));

  const pages: any[] = [];
  for (const p of [0, 1]) { const r = await fetch(`https://steamspy.com/api.php?request=all&page=${p}`); pages.push(await r.json()); await new Promise((r) => setTimeout(r, 1500)); }
  const appids = pages.flatMap((p) => Object.values(p) as any[]).map((a) => String(a.appid));

  const toIgdb = new Map<string, number>();
  for (let i = 0; i < appids.length; i += 200) {
    const batch = appids.slice(i, i + 200); let off = 0;
    for (;;) {
      const rows = await ig<{ uid: string; game: number }>("external_games", `fields uid,game; where external_game_source = 1 & uid = (${batch.map((u) => `"${u}"`).join(",")}); limit 500; offset ${off};`);
      rows.forEach((r) => toIgdb.set(r.uid, r.game));
      if (rows.length < 500) break; off += 500;
    }
  }
  const igdbIds = [...new Set([...toIgdb.values()])];
  const inCatalog = new Set<number>();
  for (let i = 0; i < igdbIds.length; i += 400) {
    const res = await fetch(`${SUPA}/rest/v1/games?select=igdb_id&igdb_id=in.(${igdbIds.slice(i, i + 400).join(",")})`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    (await res.json() as { igdb_id: number }[]).forEach((r) => inCatalog.add(r.igdb_id));
  }
  const missing = igdbIds.filter((i) => !inCatalog.has(i));
  console.log(`\nmapped IGDB games missing from catalog: ${missing.length}`);

  const byType = new Map<string, number>(); let noRating = 0, hasRating = 0, oldEnough = 0;
  for (let i = 0; i < missing.length; i += 300) {
    const rows = await ig<{ id: number; game_type: number; total_rating_count?: number; first_release_date?: number }>(
      "games", `fields id,game_type,total_rating_count,first_release_date; where id = (${missing.slice(i, i + 300).join(",")}); limit 500;`);
    for (const r of rows) {
      const n = typeName.get(r.game_type) ?? `type ${r.game_type}`;
      byType.set(n, (byType.get(n) ?? 0) + 1);
      const rc = r.total_rating_count ?? 0;
      if (rc >= 5) hasRating++; else noRating++;
      const yr = r.first_release_date ? new Date(r.first_release_date * 1000).getUTCFullYear() : 0;
      if (yr >= 2023) oldEnough++;
    }
  }
  console.log("\nwhy they are missing — IGDB game_type of the gap:");
  [...byType.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`   ${String(v).padStart(4)}  ${k}`));
  console.log(`\n   ${hasRating} of ${missing.length} have >= 5 ratings (would have passed the popularity arm)`);
  console.log(`   ${noRating} have < 5 ratings (excluded by SEED_MIN_POPULARITY)`);
  console.log(`   ${oldEnough} released 2023 or later (would have passed the date arm)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
