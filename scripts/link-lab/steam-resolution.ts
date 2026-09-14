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
async function inCatalog(ids: number[]): Promise<Set<number>> {
  const s = new Set<number>();
  for (let i = 0; i < ids.length; i += 400) {
    const res = await fetch(`${SUPA}/rest/v1/games?select=igdb_id&igdb_id=in.(${ids.slice(i, i + 400).join(",")})`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
    (await res.json() as { igdb_id: number }[]).forEach((r) => s.add(r.igdb_id));
  }
  return s;
}
async function main() {
  TOKEN = await (await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CID}&client_secret=${CS}&grant_type=client_credentials`, { method: "POST" })).json().then((j: any) => j.access_token);
  const pages: any[] = [];
  for (const p of [0, 1]) { const r = await fetch(`https://steamspy.com/api.php?request=all&page=${p}`); pages.push(await r.json()); await new Promise((r) => setTimeout(r, 1500)); }
  const apps = pages.flatMap((p) => Object.values(p) as any[]);
  const appids = apps.map((a) => String(a.appid));
  const nameOf = new Map(apps.map((a) => [String(a.appid), a.name as string]));

  const toIgdb = new Map<string, number>();
  for (let i = 0; i < appids.length; i += 200) {
    const batch = appids.slice(i, i + 200); let off = 0;
    for (;;) {
      const rows = await ig<{ uid: string; game: number }>("external_games", `fields uid,game; where external_game_source = 1 & uid = (${batch.map((u) => `"${u}"`).join(",")}); limit 500; offset ${off};`);
      rows.forEach((r) => toIgdb.set(r.uid, r.game));
      if (rows.length < 500) break; off += 500;
    }
  }
  const direct = await inCatalog([...new Set([...toIgdb.values()])]);
  const gapIds = [...new Set([...toIgdb.values()])].filter((i) => !direct.has(i));

  // fetch parent_game / version_parent for the gap
  const parentOf = new Map<number, number>();
  for (let i = 0; i < gapIds.length; i += 300) {
    const rows = await ig<{ id: number; parent_game?: number; version_parent?: number }>("games",
      `fields id,parent_game,version_parent; where id = (${gapIds.slice(i, i + 300).join(",")}); limit 500;`);
    rows.forEach((r) => { const p = r.version_parent ?? r.parent_game; if (p) parentOf.set(r.id, p); });
  }
  const parents = [...new Set([...parentOf.values()])];
  const parentInCatalog = await inCatalog(parents);
  const recovered = gapIds.filter((g) => parentOf.has(g) && parentInCatalog.has(parentOf.get(g)!));

  console.log(`gap IGDB games:                       ${gapIds.length}`);
  console.log(`  have a parent_game/version_parent:  ${parentOf.size}`);
  console.log(`  whose parent IS in our catalog:     ${recovered.length}`);

  const before = appids.filter((a) => toIgdb.has(a) && direct.has(toIgdb.get(a)!)).length;
  const rec = new Set(recovered);
  const after = appids.filter((a) => toIgdb.has(a) && (direct.has(toIgdb.get(a)!) || rec.has(toIgdb.get(a)!))).length;
  console.log(`\nSteam library resolution over ${appids.length} most-owned apps:`);
  console.log(`  direct external_games join only:    ${before} = ${(before / appids.length * 100).toFixed(1)}%`);
  console.log(`  + one parent hop:                   ${after} = ${(after / appids.length * 100).toFixed(1)}%`);

  const still = appids.filter((a) => toIgdb.has(a) && !direct.has(toIgdb.get(a)!) && !rec.has(toIgdb.get(a)!)).slice(0, 20);
  console.log(`\nstill unresolved after the hop (first 20 of ${appids.length - after}):`);
  still.forEach((a) => console.log(`   ${a}  ${nameOf.get(a)}`));
}
main().catch((e) => { console.error(e); process.exit(1); });
