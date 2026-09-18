// Measures what IGDB actually carries for the long-press quick view:
// artworks, screenshots, videos -- over two cohorts of REAL catalog rows.
import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { admin } from "../supabase-admin.ts";

const creds = igdbCreds();

type Row = { id: number; artworks?: {image_id:string}[]; screenshots?: {image_id:string}[];
  videos?: {video_id:string; name?:string}[]; summary?: string; name: string; total_rating_count?: number };

async function cohort(label: string, igdbIds: number[]) {
  const rows: Row[] = [];
  for (let i = 0; i < igdbIds.length; i += 200) {
    const chunk = igdbIds.slice(i, i + 200);
    const q = `fields name, summary, total_rating_count, artworks.image_id, screenshots.image_id, videos.video_id, videos.name; where id = (${chunk.join(",")}); limit 500;`;
    rows.push(...await igdbQuery<Row>(creds, "games", q));
  }
  const n = rows.length;
  const pct = (k: number) => `${((100 * k) / n).toFixed(1)}%`;
  const art = rows.filter(r => (r.artworks ?? []).length > 0).length;
  const shot = rows.filter(r => (r.screenshots ?? []).length > 0).length;
  const vid = rows.filter(r => (r.videos ?? []).length > 0).length;
  const either = rows.filter(r => (r.artworks ?? []).length + (r.screenshots ?? []).length > 0).length;
  const artCounts = rows.map(r => (r.artworks ?? []).length).sort((a,b)=>a-b);
  console.log(`\n=== ${label}: ${n} games (asked ${igdbIds.length}) ===`);
  console.log(`  artworks   : ${art} (${pct(art)})   median count when present: ${artCounts.filter(c=>c>0)[Math.floor(artCounts.filter(c=>c>0).length/2)] ?? 0}`);
  console.log(`  screenshots: ${shot} (${pct(shot)})`);
  console.log(`  artwork OR screenshot: ${either} (${pct(either)})`);
  console.log(`  videos     : ${vid} (${pct(vid)})`);
  return rows;
}

const { data: top } = await admin.from("games").select("igdb_id, title, total_rating_count")
  .not("total_rating_count", "is", null).order("total_rating_count", { ascending: false }).limit(400);
const { data: rated } = await admin.from("games").select("igdb_id").gte("total_rating_count", 5).limit(1000);
const { data: all } = await admin.from("games").select("igdb_id").order("igdb_id", { ascending: true }).range(20000, 20399);

const topRows = await cohort("top 400 by rating count", (top ?? []).map(r => r.igdb_id as number));
await cohort("400 sampled from rated (>=5)", (rated ?? []).slice(300, 700).map(r => r.igdb_id as number));
await cohort("400 from the long tail (unrated slice)", (all ?? []).map(r => r.igdb_id as number));

console.log("\n--- sample artwork/video URLs for the 5 most-rated ---");
for (const r of topRows.slice(0, 5)) {
  const a = r.artworks?.[0]?.image_id, s = r.screenshots?.[0]?.image_id, v = r.videos?.[0]?.video_id;
  console.log(`  ${r.name}`);
  console.log(`    artwork   : ${a ? `https://images.igdb.com/igdb/image/upload/t_1080p/${a}.jpg` : "NONE"}`);
  console.log(`    screenshot: ${s ? `https://images.igdb.com/igdb/image/upload/t_1080p/${s}.jpg` : "NONE"}`);
  console.log(`    video     : ${v ? `https://youtube.com/watch?v=${v} (${r.videos?.[0]?.name})` : "NONE"}`);
}
