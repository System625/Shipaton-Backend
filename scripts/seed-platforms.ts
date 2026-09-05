// Seeds `platforms` from IGDB /platforms. Run once, before seed-games.
// Platform ids are IGDB's and are stable, so they are used directly as the PK —
// the one place a provider id is allowed to be an identity (spec §3).

import { igdbQuery, type IgdbPlatform } from "../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";

// IGDB's own platform_family ids are incomplete (PC and mobile have none), so
// family is derived from the slug instead. It only has to be good enough to group
// the roulette's platform picker.
function familyFor(p: IgdbPlatform): string | null {
  const s = p.slug.toLowerCase();
  if (/^ps|playstation|psvita|psp/.test(s)) return "playstation";
  if (/xbox|xseriesx|xboxone/.test(s)) return "xbox";
  if (/switch|wii|nintendo|3ds|nes|snes|gamecube|n64|gameboy|gba/.test(s)) return "nintendo";
  if (/^(win|linux|mac|pc|dos|steam)/.test(s)) return "pc";
  if (/ios|android|ipad|iphone|mobile/.test(s)) return "mobile";
  return null;
}

const creds = igdbCreds();

let after = 0;
let total = 0;
for (;;) {
  const page = await igdbQuery<IgdbPlatform>(
    creds,
    "platforms",
    `fields name, slug, abbreviation, platform_family; where id > ${after}; sort id asc; limit 500;`,
  );
  if (page.length === 0) break;

  const rows = page.map((p) => ({
    id: p.id,
    slug: p.slug,
    name: p.name,
    family: familyFor(p),
  }));

  const { error } = await admin.from("platforms").upsert(rows, { onConflict: "id" });
  if (error) throw new Error(`platforms upsert failed: ${error.message}`);

  total += rows.length;
  after = page[page.length - 1].id;
  console.log(`platforms: ${total}`);
}

console.log(`done. ${total} platforms.`);
