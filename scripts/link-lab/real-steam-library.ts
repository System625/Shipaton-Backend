// Resolves a REAL Steam library against game_external_ids, end to end.
//
// docs/research/account-linking.md calls 87.8% "an optimistic bound until we run it
// against a real Steam account", because the proxy behind that figure was
// SteamSpy's 2,000 most-owned apps and a real library skews cheaper and more
// obscure. This is that run. It needs no linked Shelf account and no OpenID
// handshake — GetOwnedGames works on any public profile — so it can be pointed at a
// vanity name today and at a real user the moment one connects.
//
//   npx tsx scripts/link-lab/real-steam-library.ts st4ck
//   npx tsx scripts/link-lab/real-steam-library.ts 76561198023414915
//
// Read-only. Resolves through the same RPC the import uses, so it measures the
// shipping path rather than a copy of it — the trap verify-igdb.ts check 3 fell into.

import { admin } from "../supabase-admin.ts";
import { required } from "../env.ts";
import { fetchOwnedGames, SteamProfilePrivateError } from "../../supabase/functions/_shared/steam.ts";
import { minutesToHoursClamped, HOURS_PLAYED_MAX } from "../../supabase/functions/_shared/platform-import.ts";

const KEY = required("STEAM_WEB_API_KEY");

async function resolveSteamId(input: string): Promise<string> {
  if (/^\d{17}$/.test(input)) return input;
  const res = await fetch(
    `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${KEY}&vanityurl=${encodeURIComponent(input)}`,
  );
  const body = (await res.json()) as { response?: { steamid?: string } };
  if (!body.response?.steamid) throw new Error(`no such vanity name: ${input}`);
  return body.response.steamid;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: real-steam-library.ts <steamid64 | vanity name>");
    process.exit(1);
  }

  const steamId = await resolveSteamId(arg);
  console.log(`\nSteamID64 ${steamId}`);

  let owned;
  try {
    owned = await fetchOwnedGames(KEY, steamId);
  } catch (e) {
    if (e instanceof SteamProfilePrivateError) {
      console.error("\nThat profile's Game details are not Public, so Steam returns an\n" +
        "empty library. This is the failure mode section 3 predicts will be our top\n" +
        "support complaint, and it looks like success rather than an error.");
      process.exit(1);
    }
    throw e;
  }

  console.log(`${owned.length} owned apps.\n`);

  // Resolve in batches. The RPC is `stable` and reads only the id map, so the
  // service role here measures exactly what a user's JWT would.
  const uids = owned.map((g) => String(g.appid));
  const hit = new Map<string, { game_id: string; via_parent: boolean }>();
  for (let i = 0; i < uids.length; i += 1000) {
    const { data, error } = await admin.rpc("shelf_resolve_external_ids", {
      p_source: "steam", p_uids: uids.slice(i, i + 1000),
    });
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as { uid: string; game_id: string; via_parent: boolean }[]) {
      hit.set(r.uid, { game_id: r.game_id, via_parent: r.via_parent });
    }
  }

  const direct = [...hit.values()].filter((v) => !v.via_parent).length;
  const hopped = [...hit.values()].filter((v) => v.via_parent).length;
  const games = new Set([...hit.values()].map((v) => v.game_id));
  const pct = (n: number) => ((n / owned.length) * 100).toFixed(1) + "%";

  console.log(`  direct join only        ${direct} = ${pct(direct)}`);
  console.log(`  + one parent hop        ${direct + hopped} = ${pct(direct + hopped)}`);
  console.log(`  distinct catalog games  ${games.size}  (${hit.size - games.size} collapsed onto a shared parent)`);
  console.log(`  unresolved              ${owned.length - hit.size} = ${pct(owned.length - hit.size)}`);
  console.log(`\n  the SteamSpy proxy predicted 78.1% direct / 87.8% with the hop.`);

  // THE NUMBER THAT ACTUALLY DECIDES WHETHER THE FEATURE FEELS GOOD.
  //
  // "Owned" and "cared about" are wildly different sets on Steam, because bundles
  // and free weekends put hundreds of apps in a library its owner has never opened.
  // A user judges the import by whether the games they PLAY showed up, and those
  // are both more popular and far more likely to be in our seed. So resolution over
  // the played subset is the honest headline, and resolution over everything owned
  // is the footnote.
  const subset = (rows: typeof owned, label: string) => {
    if (rows.length === 0) return;
    const ok = rows.filter((g) => hit.has(String(g.appid))).length;
    console.log(`  ${label.padEnd(34)} ${ok}/${rows.length} = ${((ok / rows.length) * 100).toFixed(1)}%`);
  };
  const played = owned.filter((g) => (g.playtime_forever ?? 0) > 0);
  const byTime = [...owned].sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0));
  console.log(`\n  resolution by how much the user actually plays them:`);
  subset(owned, "everything owned");
  subset(played, "ever played at all");
  subset(played.filter((g) => (g.playtime_forever ?? 0) >= 60), "played over an hour");
  subset(byTime.slice(0, 50), "top 50 by playtime");
  subset(byTime.slice(0, 20), "top 20 by playtime");

  const clamped = owned.filter((g) => minutesToHoursClamped(g.playtime_forever) >= HOURS_PLAYED_MAX);
  const top = [...owned].sort((a, b) => (b.playtime_forever ?? 0) - (a.playtime_forever ?? 0))[0];
  console.log(`\n  longest playtime        ${minutesToHoursClamped(top?.playtime_forever)}h — ${top?.name}`);
  console.log(`  rows the clamp caught   ${clamped.length}  (each one would fail the whole import unclamped)`);

  const misses = owned.filter((g) => !hit.has(String(g.appid)));
  console.log(`\n  first 25 unresolved — expect non-games (Blender, Wallpaper Engine) among them:`);
  for (const m of misses.slice(0, 25)) console.log(`    ${String(m.appid).padStart(8)}  ${m.name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
