// Are IGDB's YouTube video ids still playable? Checks via YouTube oEmbed, which
// 404s for deleted/private videos and 401s for embedding-disabled ones.
import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { admin } from "../supabase-admin.ts";

const creds = igdbCreds();
const { data: top } = await admin.from("games").select("igdb_id, title")
  .not("total_rating_count", "is", null)
  .order("total_rating_count", { ascending: false }).limit(150);
const ids = (top ?? []).map(r => r.igdb_id as number);

type Vid = { game: number; video_id: string; name?: string };
const vids: Vid[] = [];
for (let i = 0; i < ids.length; i += 100) {
  vids.push(...await igdbQuery<Vid>(creds, "game_videos",
    `fields game, video_id, name; where game = (${ids.slice(i, i+100).join(",")}); limit 500;`));
}
// one video per game, prefer a trailer
const byGame = new Map<number, Vid>();
for (const v of vids) {
  const cur = byGame.get(v.game);
  if (!cur || (/trailer/i.test(v.name ?? "") && !/trailer/i.test(cur.name ?? ""))) byGame.set(v.game, v);
}
const sample = [...byGame.values()].slice(0, 120);
let ok = 0, gone = 0, noEmbed = 0;
const failures: string[] = [];
for (const v of sample) {
  const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${v.video_id}&format=json`);
  if (res.ok) ok++;
  else if (res.status === 401 || res.status === 403) { noEmbed++; failures.push(`${v.video_id} embed-blocked ${res.status}`); }
  else { gone++; failures.push(`${v.video_id} ${res.status}`); }
}
console.log(`games sampled: ${sample.length} of ${ids.length} most-rated (${byGame.size} had any video)`);
console.log(`  playable/embeddable : ${ok} (${(100*ok/sample.length).toFixed(1)}%)`);
console.log(`  embedding disabled  : ${noEmbed}`);
console.log(`  gone / private / 404: ${gone}`);
if (failures.length) console.log("  first failures:", failures.slice(0, 10).join(", "));
