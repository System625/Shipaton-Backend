// Prints the curated Android package-name list the app's `<queries>` manifest
// needs — docs/research/account-linking.md §7: "A curated top-500 list shipped
// in the manifest is therefore not a shortcut, it is a requirement... the
// app-side list and our catalog have to be built from the same IGDB query, or
// they will disagree." This IS that query: it reads game_external_ids directly,
// so the manifest can never name a package our catalog does not also resolve.
//
// Android's Package Visibility rules (API 30+) mean an app cannot simply ask
// "what is installed" — it must declare, in advance, every package name it wants
// to be able to see. `game_external_ids` already holds all 3,036 IGDB-known
// Android package names; this just orders them by popularity and cuts to a size
// Sola can actually paste into AndroidManifest.xml.
//
// Usage: npx tsx scripts/generate-android-manifest.ts [count]
//   count defaults to 500, matching the research doc's own number.

import { admin } from "./supabase-admin.ts";
import { pathToFileURL } from "node:url";

type Row = {
  title: string;
  total_rating_count: number | null;
  game_external_ids: { uid: string }[];
};

export async function androidManifestPackages(count: number): Promise<{ uid: string; title: string }[]> {
  // Queried FROM games, not from game_external_ids: PostgREST can only order the
  // top-level resource by its own columns, and game_external_ids has no
  // popularity signal of its own. Ordering games by total_rating_count and
  // embedding the matching edge is what actually sorts the output by popularity
  // — the earlier version of this query embedded games FROM game_external_ids and
  // asked PostgREST to order by the embedded column, which it silently accepts
  // and does not do; it ordered nothing; caught by eyeballing the printed list.
  // Over-fetch games: deduping uids below can only shrink the result, and a
  // games-level limit of exactly `count` routinely lands a bit short of `count`
  // unique packages once shared/duplicate edges collapse (measured: 500 games ->
  // 471 unique uids). 20% headroom is comfortably enough at this table's size.
  const { data, error } = await admin
    .from("games")
    .select("title, total_rating_count, game_external_ids!inner(uid)")
    .eq("game_external_ids.source", "android")
    .order("total_rating_count", { ascending: false, nullsFirst: false })
    .limit(Math.ceil(count * 1.2));
  if (error) throw new Error(`read failed: ${error.message}`);

  // Two reasons the same uid can appear twice before this dedupe: a game can
  // carry more than one android edge (Minecraft: Java/Bedrock), and — per
  // game_external_ids' own header comment — "one id can legitimately reach more
  // than one catalog game," so a single package name can be paired with two
  // different game rows. Either way the manifest wants the package name ONCE;
  // `<queries>` declares visibility, it does not count occurrences. Kept in
  // popularity order, first (highest-rated) occurrence wins the title shown.
  const seen = new Map<string, string>();
  for (const r of (data ?? []) as unknown as Row[]) {
    for (const e of r.game_external_ids) if (!seen.has(e.uid)) seen.set(e.uid, r.title);
  }
  return [...seen.entries()].slice(0, count).map(([uid, title]) => ({ uid, title }));
}

// A title is printed inside an XML comment, and XML comments may not contain "--"
// or end in "-" — a single title like "Sword -- Sworcery" would make the whole file
// unparseable, which is exactly how docs/android-manifest-packages.xml shipped broken
// once: a "--" in its hand-written header meant browsers and every XML reader refused
// the file. Nothing downstream re-escapes this, so it has to be right here.
function commentSafe(title: string): string {
  return title.replace(/-{2,}/g, "-").replace(/-+$/, "").trim();
}

async function main() {
  const count = Number(process.argv[2] ?? 500);
  const rows = await androidManifestPackages(count);

  // Emitted as a complete, valid <queries> document rather than bare <package> lines:
  // it is handed to Sola as a file, so it has to parse on its own to be readable in a
  // browser. AndroidManifest.xml declares xmlns:android on its own <manifest> root, so
  // the declaration here is only what makes this file standalone.
  console.log(`<?xml version="1.0" encoding="utf-8"?>`);
  console.log(`<!-- ${rows.length} package names, by total_rating_count desc -->`);
  console.log(`<queries xmlns:android="http://schemas.android.com/apk/res/android">`);
  for (const r of rows) console.log(`    <package android:name="${r.uid}" /> <!-- ${commentSafe(r.title)} -->`);
  console.log(`</queries>`);

  console.log(`\n<!-- same list, as JSON, for the app's own resolve step -->\n`);
  console.log(JSON.stringify(rows.map((r) => r.uid)));
}

const isEntryPoint = process.argv[1] != null &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
