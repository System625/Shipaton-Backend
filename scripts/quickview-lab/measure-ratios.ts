// Ratio distribution of IGDB artworks vs screenshots, from the endpoints' own
// width/height fields (no downloads). Cohort: catalog rows by rating count.
import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { admin } from "../supabase-admin.ts";

const creds = igdbCreds();
type Asset = { id: number; game: number; width: number; height: number; image_id: string };

const { data: top } = await admin.from("games").select("igdb_id")
  .not("total_rating_count", "is", null)
  .order("total_rating_count", { ascending: false }).limit(600);
const ids = (top ?? []).map(r => r.igdb_id as number);

async function pull(endpoint: string): Promise<Asset[]> {
  const out: Asset[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    out.push(...await igdbQuery<Asset>(creds, endpoint,
      `fields game, width, height, image_id; where game = (${chunk.join(",")}); limit 500;`));
  }
  return out;
}

for (const endpoint of ["artworks", "screenshots"]) {
  const rows = await pull(endpoint);
  const n = rows.length;
  const ratios = rows.map(r => r.width / r.height);
  const portrait = ratios.filter(r => r < 1).length;
  const near43 = ratios.filter(r => r >= 1.25 && r < 1.5).length;
  const near169 = ratios.filter(r => r >= 1.7 && r <= 1.82).length;
  const ultra = ratios.filter(r => r > 2.2).length;
  const small = rows.filter(r => r.height < 720).length;
  const sorted = [...ratios].sort((a,b)=>a-b);
  const q = (p: number) => sorted[Math.floor(p * sorted.length)].toFixed(3);
  console.log(`\n=== ${endpoint}: ${n} assets over ${new Set(rows.map(r=>r.game)).size} games ===`);
  console.log(`  ratio p10 ${q(0.1)}  median ${q(0.5)}  p90 ${q(0.9)}   min ${sorted[0].toFixed(3)} max ${sorted[sorted.length-1].toFixed(3)}`);
  console.log(`  portrait (<1.0): ${portrait} (${(100*portrait/n).toFixed(1)}%)`);
  console.log(`  ~4:3          : ${near43} (${(100*near43/n).toFixed(1)}%)`);
  console.log(`  ~16:9         : ${near169} (${(100*near169/n).toFixed(1)}%)`);
  console.log(`  ultrawide >2.2: ${ultra} (${(100*ultra/n).toFixed(1)}%)`);
  console.log(`  height < 720px: ${small} (${(100*small/n).toFixed(1)}%)  <- t_1080p would upscale these`);
}
