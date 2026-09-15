// Measures the Xbox ceiling: how much of our catalog can an Xbox import resolve
// DETERMINISTICALLY, rather than by matching on the game's display name?
//
// WHY THIS SCRIPT EXISTS. docs/research/account-linking.md section 2 says there is
// "no lookup table to build, at any price" between IGDB's Microsoft Store product
// id (`9NDXJG3LSP32`) and the Xbox Live title id OpenXBL returns (`1777860928`).
// Josh challenged that on 14 Sep and he is right that a bridge exists: Microsoft's
// own DisplayCatalog returns `XboxTitleId` in a product's `AlternateIds`. What
// nobody had done was count it. His instruction, verbatim: "run the batch job first
// and measure it... That number tells you your Xbox ceiling. If it's above 70%
// you're in good shape; below 50% and you're back to name matching as the primary
// path rather than the fallback."
//
// This is the batch job. It is a BUILD-TIME measurement and a build-time artifact,
// never a runtime dependency — DisplayCatalog is unofficial and may change or
// rate-limit, and an import must not go down with it.
//
//   npx tsx scripts/link-lab/xbox-title-bridge.ts            # measure only
//   npx tsx scripts/link-lab/xbox-title-bridge.ts --write    # also write the map

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { igdbQuery } from "../../supabase/functions/_shared/igdb.ts";
import { igdbCreds } from "../env.ts";
import { admin } from "../supabase-admin.ts";

const creds = igdbCreds();
const WRITE = process.argv.includes("--write");

// DisplayCatalog. Unofficial, unauthenticated, and Microsoft says it can change.
// That is the same risk class as OpenXBL, which the Xbox import already depends on,
// so it adds no new exposure — but it is why the output is checked in rather than
// called live.
const DISPLAY_CATALOG = "https://displaycatalog.mp.microsoft.com/v7.0/products";
const BATCH = 20;
const PAUSE_MS = 150;

// Source 11 is "Microsoft", and it is not homogeneous: alongside modern Store
// product ids it carries 360-era rows whose uid is a GUID with an `xbox360` prefix.
// Those are not bigIds and DisplayCatalog 404s them, so they are excluded here and
// counted separately rather than silently depressing the hit rate.
const STORE_PRODUCT_ID = /^[A-Z0-9]{12}$/;

type AlternateId = { IdType: string; Value: string };

async function displayCatalog(bigIds: string[]): Promise<Map<string, string>> {
  const url =
    `${DISPLAY_CATALOG}?bigIds=${bigIds.join(",")}&market=US&languages=en-us` +
    `&MS-CV=${Math.random().toString(36).slice(2)}`;
  const res = await fetch(url);
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 5000));
    return displayCatalog(bigIds);
  }
  if (!res.ok) return new Map();

  const body = (await res.json()) as { Products?: { ProductId: string; AlternateIds?: AlternateId[] }[] };
  const out = new Map<string, string>();
  for (const p of body.Products ?? []) {
    const titleId = p.AlternateIds?.find((a) => a.IdType === "XboxTitleId")?.Value;
    if (titleId) out.set(p.ProductId, titleId);
  }
  return out;
}

/**
 * Catalog games on an Xbox platform: 49 = Xbox One, 169 = Series X|S, 12 = 360.
 * Returns every one, plus the subset with >= 5 IGDB user ratings.
 *
 * BOTH DENOMINATORS MATTER AND THEY DISAGREE BY 25 POINTS. "Every Xbox game in our
 * catalog" is the wrong question: an import only ever sees games somebody actually
 * played, and a played library is popularity-weighted. The rated subset is the
 * closer proxy, and it is the one to quote for what a user will experience. The
 * full set is the floor.
 */
async function xboxCatalogIgdbIds(): Promise<{ all: Set<number>; rated: Set<number> }> {
  const all = new Set<number>();
  const rated = new Set<number>();
  // Keyset, not OFFSET. The `.range()` version of this loop read a different and
  // incomplete subset of the catalog on every run -- no ORDER BY means no stable row
  // order, so the windows skip and repeat (see seed-external-ids.ts for the measured
  // numbers). THE 63.3% BRIDGE FIGURE FROM 14 SEP WAS MEASURED THAT WAY and its
  // denominator was therefore about two thirds of the eligible catalog. Re-run this
  // before anyone builds on that number.
  let after = 0;
  for (;;) {
    const { data, error } = await admin
      .from("games")
      .select("igdb_id, total_rating_count, game_platforms!inner(platform_id)")
      .in("game_platforms.platform_id", [49, 169, 12])
      .not("igdb_id", "is", null)
      .gt("igdb_id", after)
      .order("igdb_id", { ascending: true })
      .limit(1000);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    for (const r of data) {
      all.add(r.igdb_id as number);
      if ((r.total_rating_count as number ?? 0) >= 5) rated.add(r.igdb_id as number);
    }
    after = data[data.length - 1].igdb_id as number;
  }
  return { all, rated };
}

// DisplayCatalog answers do not change hour to hour, and re-running the measurement
// should not cost another 4,700 requests against somebody else's unofficial
// endpoint. Delete the file to force a fresh pull.
const CACHE = new URL("./.xbox-title-cache.json", import.meta.url).pathname;

async function main() {
  console.log("reading catalog and IGDB microsoft external ids...");
  const { all: xboxCatalog, rated: xboxRated } = await xboxCatalogIgdbIds();

  const rows: { uid: string; game: number }[] = [];
  let after = 0;
  for (;;) {
    const page = await igdbQuery<{ id: number; uid?: string; game?: number }>(
      creds, "external_games",
      `fields uid, game; where external_game_source = 11 & id > ${after}; sort id asc; limit 500;`,
    );
    if (page.length === 0) break;
    for (const r of page) if (r.uid && r.game) rows.push({ uid: r.uid, game: r.game });
    after = page[page.length - 1].id;
  }

  const legacy = rows.filter((r) => !STORE_PRODUCT_ID.test(r.uid));
  const modern = rows.filter((r) => STORE_PRODUCT_ID.test(r.uid));
  const inCatalog = modern.filter((r) => xboxCatalog.has(r.game));

  console.log(`\n  IGDB microsoft external rows      ${rows.length}`);
  console.log(`    360-era / non-bigId uids        ${legacy.length}  (excluded, not lookupable)`);
  console.log(`    store product ids               ${modern.length}`);
  console.log(`    ...of games in OUR catalog      ${inCatalog.length}`);
  console.log(`  our catalog on an Xbox platform   ${xboxCatalog.size} games\n`);

  const bigIds = [...new Set(inCatalog.map((r) => r.uid))];
  const titleIdOf = new Map<string, string>(
    existsSync(CACHE) ? Object.entries(JSON.parse(readFileSync(CACHE, "utf8"))) : [],
  );
  const todo = bigIds.filter((b) => !titleIdOf.has(b));
  if (titleIdOf.size > 0) console.log(`  cache: ${titleIdOf.size} known, ${todo.length} to fetch`);
  for (let i = 0; i < todo.length; i += BATCH) {
    const found = await displayCatalog(todo.slice(i, i + BATCH));
    for (const [k, v] of found) titleIdOf.set(k, v);
    if (i % (BATCH * 25) === 0) {
      process.stdout.write(`\r  DisplayCatalog ${Math.min(i + BATCH, todo.length)}/${todo.length}  titleIds: ${titleIdOf.size}`);
    }
    await new Promise((r) => setTimeout(r, PAUSE_MS));
  }
  console.log();
  writeFileSync(CACHE, JSON.stringify(Object.fromEntries(titleIdOf)));

  // The number Josh asked for: of the catalog games an Xbox import could possibly
  // see, how many end up reachable by a deterministic id rather than by name?
  const reachable = new Set(inCatalog.filter((r) => titleIdOf.has(r.uid)).map((r) => r.game));
  const withAnyMsId = new Set(inCatalog.map((r) => r.game));
  const resolvedBigIds = bigIds.filter((b) => titleIdOf.has(b)).length;

  const pct = (n: number, d: number) => ((n / d) * 100).toFixed(1) + "%";
  const only = (s: Set<number>, f: Set<number>) => [...s].filter((x) => f.has(x)).length;

  console.log(`\n=== the Xbox ceiling ===`);
  console.log(`  the BRIDGE itself — store id -> XboxTitleId`);
  console.log(`    ${resolvedBigIds}/${bigIds.length} = ${pct(resolvedBigIds, bigIds.length)}   (Josh was right: it works)`);
  console.log(`\n  end to end, ALL ${xboxCatalog.size} catalog Xbox games`);
  console.log(`    carry ANY microsoft id    ${withAnyMsId.size} = ${pct(withAnyMsId.size, xboxCatalog.size)}`);
  console.log(`    reachable by title id     ${reachable.size} = ${pct(reachable.size, xboxCatalog.size)}`);
  console.log(`\n  end to end, the ${xboxRated.size} with >= 5 ratings (the closer proxy for a played library)`);
  console.log(`    carry ANY microsoft id    ${only(withAnyMsId, xboxRated)} = ${pct(only(withAnyMsId, xboxRated), xboxRated.size)}`);
  console.log(`    reachable by title id     ${only(reachable, xboxRated)} = ${pct(only(reachable, xboxRated), xboxRated.size)}`);
  console.log(`\n  Josh's thresholds: >70% build id-first, <50% keep name matching primary.`);
  console.log(`  Name matching measured 97.0% rank-1 / 99.5% top-5 (section 2a) — so`);
  console.log(`  compare against that, not against zero.`);

  if (!WRITE) {
    console.log(`\n  (measure only — pass --write to persist the map)`);
    return;
  }

  // MANY-TO-MANY ON PURPOSE, per Josh's second caveat: one bigId can carry several
  // title ids across 360/One/Series, and editions produce several bigIds per game.
  // The edge table already allows that; nothing here forces a winner.
  //
  // CHUNKED: a plain `.in("igdb_id", [...reachable])` sends every id on the URL
  // (PostgREST's GET filter syntax, not a request body), and `reachable` runs into
  // the thousands post-widening -- 4,353 ids here on 15 Sep. That is a request line
  // past what a proxy in front of this project will pass, and it fails the whole
  // call with a bare "Bad Request", nothing pointing at the actual cause.
  const uuidOf = new Map<number, string>();
  const reachableArr = [...reachable];
  for (let i = 0; i < reachableArr.length; i += 500) {
    const { data: catalogRows, error } = await admin
      .from("games").select("id, igdb_id")
      .in("igdb_id", reachableArr.slice(i, i + 500));
    if (error) throw new Error(error.message);
    for (const r of catalogRows ?? []) uuidOf.set(r.igdb_id as number, r.id as string);
  }

  const edges = inCatalog.flatMap((r) => {
    const titleId = titleIdOf.get(r.uid);
    const gameId = uuidOf.get(r.game);
    return titleId && gameId
      ? [{ source: "xbox_title", uid: titleId, game_id: gameId, via_parent: false, igdb_id: r.game }]
      : [];
  });
  console.log(`\n  writing ${edges.length} xbox_title edges...`);
  for (let i = 0; i < edges.length; i += 1000) {
    const { error: e } = await admin
      .from("game_external_ids")
      .upsert(edges.slice(i, i + 1000), { onConflict: "source,uid,game_id" });
    if (e) throw new Error(e.message);
  }
  console.log("  done.");
}

main().catch((e) => { console.error(e); process.exit(1); });
