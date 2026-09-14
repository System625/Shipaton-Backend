// Seeds `platforms` from IGDB /platforms. Run once, before seed-games.
// Platform ids are IGDB's and are stable, so they are used directly as the PK —
// the one place a provider id is allowed to be an identity (spec §3).

import { igdbQuery, type IgdbPlatform } from "../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "./env.ts";
import { admin } from "./supabase-admin.ts";

// IGDB's own platform_family ids are incomplete (PC and mobile have none), so
// family is grouped here instead. It backs the Device Type pill on the search
// screen, so it is user-facing and has to be right.
//
// BY ID, NOT BY SLUG. This used to be a slug regex, and it silently lost Xbox
// Series X|S -- slug `series-x-s`, which matches neither /xbox/ nor /xboxone/ --
// along with GameCube (`ngc`), Nintendo DS (`nds`), Game Boy (`gb`, `gbc`) and
// the Famicom line. That is 4,035 catalog rows on the current-generation Xbox
// alone, filed under no family and unreachable from the Xbox pill. IGDB platform
// ids are stable and are already this table's primary key; slugs are the thing
// that drifted. See migration 20260914130000_platform_family_fix.sql.
//
// Platforms that belong to no pill stay null on purpose: Sega, Atari, Commodore,
// Amiga, Neo Geo, arcade, MSX, Meta Quest, Oculus, Stadia and Web browser have no
// home among PlayStation / Xbox / Nintendo / PC / Mobile.
const FAMILY_IDS: Record<string, number[]> = {
  playstation: [7, 8, 9, 38, 46, 48, 165, 167, 390],
  xbox: [11, 12, 49, 169],
  nintendo: [4, 5, 18, 19, 20, 21, 22, 24, 33, 37, 41, 58, 87, 99, 130, 137, 159, 306, 307, 416, 508],
  pc: [3, 6, 13, 14, 125, 142, 149, 161, 163, 274],
  mobile: [34, 39, 42, 44, 55, 73, 240, 405, 417, 74],
};

const FAMILY_BY_ID = new Map<number, string>(
  Object.entries(FAMILY_IDS).flatMap(([fam, ids]) => ids.map((id) => [id, fam] as const)),
);

function familyFor(p: IgdbPlatform): string | null {
  return FAMILY_BY_ID.get(p.id) ?? null;
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
