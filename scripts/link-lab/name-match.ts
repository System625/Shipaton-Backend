// Can name matching stand in for the ID join on Xbox and PlayStation?
// IGDB's external_games.name is the STORE's own display name for the product --
// the same string PSN and Xbox hand back in a title list. So it is a fair proxy
// for the import's real input. Ground truth is the IGDB game the row points at.
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
async function rpc(fn: string, args: unknown) {
  const res = await fetch(`${SUPA}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: SRK, Authorization: `Bearer ${SRK}`, "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`rpc ${fn} ${res.status} ${await res.text()}`);
  return await res.json();
}
async function main() {
  TOKEN = await (await fetch(`https://id.twitch.tv/oauth2/token?client_id=${CID}&client_secret=${CS}&grant_type=client_credentials`, { method: "POST" })).json().then((j: any) => j.access_token);

  for (const [label, src] of [["PlayStation Store", 36], ["Xbox / Microsoft Store", 11]] as [string, number][]) {
    // Sample store rows that carry a name, sorted for determinism.
    const rows: { name: string; game: number }[] = [];
    for (let off = 0; rows.length < 600 && off < 6000; off += 500) {
      const page = await ig<{ name?: string; game: number }>("external_games",
        `fields name,game; where external_game_source = ${src} & name != null; sort id desc; limit 500; offset ${off};`);
      page.forEach((r) => { if (r.name) rows.push({ name: r.name, game: r.game }); });
      if (page.length < 500) break;
    }
    // Keep only rows whose target game IS in our catalog -- otherwise a miss is a
    // catalog gap, not a matcher failure, and we already measured catalog gaps.
    const ids = [...new Set(rows.map((r) => r.game))];
    const uuidByIgdb = new Map<number, string>();
    for (let i = 0; i < ids.length; i += 400) {
      const res = await fetch(`${SUPA}/rest/v1/games?select=id,igdb_id&igdb_id=in.(${ids.slice(i, i + 400).join(",")})`, { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } });
      (await res.json() as { id: string; igdb_id: number }[]).forEach((r) => uuidByIgdb.set(r.igdb_id, r.id));
    }
    const cases = rows.filter((r) => uuidByIgdb.has(r.game)).slice(0, 400);

    let rank1 = 0, top5 = 0, none = 0;
    const wrong: string[] = [];
    for (const c of cases) {
      const out = await rpc("shelf_search_games", { q: c.name, max_results: 5 }) as { id: string; title: string }[];
      if (out.length === 0) { none++; continue; }
      const want = uuidByIgdb.get(c.game)!;
      if (out[0].id === want) rank1++;
      if (out.some((o) => o.id === want)) top5++;
      else if (wrong.length < 6) wrong.push(`"${c.name}" -> "${out[0].title}"`);
    }
    const n = cases.length;
    console.log(`\n## ${label} store name -> shelf_search_games   (${n} names, target in catalog)`);
    console.log(`   rank 1 correct   ${rank1}/${n} = ${(rank1 / n * 100).toFixed(1)}%`);
    console.log(`   in top 5         ${top5}/${n} = ${(top5 / n * 100).toFixed(1)}%`);
    console.log(`   returned nothing ${none}/${n}`);
    console.log(`   wrong at rank 1, samples:`);
    wrong.forEach((w) => console.log(`     ${w}`));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
