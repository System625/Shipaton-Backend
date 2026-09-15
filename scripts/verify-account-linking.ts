// Exercises account linking against real signed JWTs.
//
// What this can and cannot prove. The OpenID handshake needs a human at Steam's
// sign-in page, so the three /steam-link-* functions are checked for the things
// that do not need one: that they refuse unauthenticated callers, that a nonce is
// scoped to the user who minted it, and that an unverified nonce cannot be
// redeemed. Everything AFTER the handshake — resolution, the clamp, the dedupe, the
// "fill blanks, don't relitigate" rule, and disconnect — is exercised end to end,
// because that is where the four defects in section 8 live.
//
// The service role cannot answer any of this: it bypasses RLS and would pass the
// policy checks whether the policies existed or not. So everything runs through
// real sessions, the same rule as verify-wishlist.ts.
//
// Safe to re-run; creates two users and removes them at the end.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUp, removeAccounts, makeChecker } from "./social-accounts.ts";
import { minutesToHoursClamped, HOURS_PLAYED_MAX } from "../supabase/functions/_shared/platform-import.ts";
import { fetchOwnedGames } from "../supabase/functions/_shared/steam.ts";

const { check, finish } = makeChecker();
const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");

async function main() {
  console.log(`\nAccount linking verification\n`);

  // ---- 0. The prerequisite ----
  console.log("0. game_external_ids (the prerequisite)");
  const { count: edgeCount, error: edgeError } = await admin
    .from("game_external_ids").select("*", { count: "exact", head: true });
  check("the table exists", !edgeError, edgeError?.message);
  check("it has been seeded", (edgeCount ?? 0) > 0,
    `${edgeCount ?? 0} edges — run \`npm run seed:external-ids\``);
  if (!edgeCount) { finish(); return; }

  const { count: steamCount } = await admin.from("game_external_ids")
    .select("*", { count: "exact", head: true }).eq("source", "steam");
  const { count: hopCount } = await admin.from("game_external_ids")
    .select("*", { count: "exact", head: true }).eq("source", "steam").eq("via_parent", true);
  console.log(`      ${steamCount} steam edges, ${hopCount} of them via a parent hop`);
  check("the parent hop actually produced edges", (hopCount ?? 0) > 0,
    "without these an import loses ~10 points of a real library");

  // UPDATED 15 Sep 2026: Skyrim + Skyrim Special Edition used to be the real pair
  // that collapses onto one catalog game via the parent hop, and this check
  // asserted that. The 15 Sep catalog widening (6508442, "admit re-releases")
  // gave Special Edition its OWN catalog row (igdb_id 19457, distinct from base
  // Skyrim's 472) — confirmed live. shelf_resolve_external_ids now correctly
  // prefers 489830's DIRECT edge to that row over its PARENT-HOP edge to base
  // Skyrim (its documented "direct beats hop" order, e.g. via_parent asc). Collapsing
  // them would now be the bug: a user's Special Edition hours would silently vanish
  // into the base game's row. This checks the new, correct behaviour instead.
  const { data: collisions } = await admin.rpc("shelf_resolve_external_ids", {
    p_source: "steam", p_uids: ["72850", "489830"],  // Skyrim, Skyrim Special Edition
  });
  const skyrim = (collisions ?? []) as { uid: string; game_id: string; via_parent: boolean }[];
  const base = skyrim.find((r) => r.uid === "72850");
  const se = skyrim.find((r) => r.uid === "489830");
  check("Skyrim Special Edition resolves to its own catalog row, not the base game's",
    !!se && !se.via_parent && se.game_id !== base?.game_id,
    skyrim.map((r) => `${r.uid}->${r.game_id.slice(0, 8)}${r.via_parent ? " (hop)" : ""}`).join(" "));

  // ---- 1. The clamp (defect 8a) ----
  console.log("\n1. The playtime clamp");
  check("547,236 minutes (the real CS2 figure) -> 9120.6h", minutesToHoursClamped(547236) === 9120.6,
    String(minutesToHoursClamped(547236)));
  check("600,000 minutes clamps rather than overflowing numeric(5,1)",
    minutesToHoursClamped(600000) === HOURS_PLAYED_MAX, String(minutesToHoursClamped(600000)));
  check("absent playtime is 0, not null", minutesToHoursClamped(undefined) === 0);

  // ---- 1a. The GetOwnedGames query string ----
  //
  // A regression guard with a real bill behind it. `skip_unvetted_apps` defaults to
  // TRUE on Steam's side, and with the default the first outside tester's import
  // returned 5 games instead of 7 — losing two games that were already in our
  // catalog, with no error anywhere. Nothing else in this script can see a dropped
  // query parameter, because the call still succeeds and still writes real rows.
  // Same failure shape as the `setof` truncation: success, at a fraction of the job.
  console.log("\n1a. The GetOwnedGames query string");
  {
    const seen: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response(JSON.stringify({ response: { game_count: 0, games: [] } })));
    }) as typeof fetch;
    try {
      await fetchOwnedGames("test-key", "76561199670893904");
    } finally {
      globalThis.fetch = realFetch;
    }
    const url = seen[0] ?? "";
    check("skip_unvetted_apps=0 is sent (default true silently drops owned games)",
      url.includes("skip_unvetted_apps=0"), url.replace(/key=[^&]*/, "key=***"));
    check("include_played_free_games=1 is sent", url.includes("include_played_free_games=1"));
    check("include_appinfo=1 is sent (names for the unmatched list)", url.includes("include_appinfo=1"));
  }

  const alice = await signUp("la");
  const bob = await signUp("lb");
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // Prove the clamp is not theatre: the unclamped value really does fail.
    const { data: anyGame } = await admin.from("games").select("id").limit(1).single();
    const { error: overflow } = await alice.client.from("library_entries")
      .insert({ game_id: anyGame!.id, status: "backlog", hours_played: 10000 });
    check("an unclamped 10,000h is rejected by the column (22003)",
      overflow?.code === "22003", overflow?.code ?? "no error — the column was widened?");
    await alice.client.from("library_entries").delete().eq("game_id", anyGame!.id);

    // ---- 2. RLS ----
    console.log("\n2. Who can see what");
    const { data: edgesAsUser, error: edgeReadError } = await alice.client
      .from("game_external_ids").select("uid").limit(1);
    check("a signed-in user can read the id map (the import needs this)",
      !edgeReadError && (edgesAsUser?.length ?? 0) === 1, edgeReadError?.message);
    const { data: edgesAsAnon } = await anon.from("game_external_ids").select("uid").limit(1);
    check("anon cannot", (edgesAsAnon?.length ?? 0) === 0);

    await alice.client.from("platform_accounts").insert({
      platform: "steam", external_id: `7656119${alice.userId.slice(0, 10).replace(/\D/g, "").padEnd(10, "1")}`,
      display_name: "alice-steam",
    });
    const { data: bobSees } = await bob.client.from("platform_accounts").select("*");
    check("one user cannot see another's connection", (bobSees?.length ?? 0) === 0);

    const { error: forgeError } = await bob.client.from("platform_accounts")
      .insert({ user_id: alice.userId, platform: "xbox", external_id: "forged" });
    check("nor write one onto their account (42501)", forgeError?.code === "42501",
      forgeError?.code);

    // ---- 3. The nonce handshake ----
    console.log("\n3. The link handshake");
    const nonce = `verify-${Date.now()}`;
    await alice.client.from("platform_link_nonces")
      .insert({ nonce, user_id: alice.userId, platform: "steam" });
    const { data: bobNonce } = await bob.client.from("platform_link_nonces")
      .select("*").eq("nonce", nonce);
    check("a nonce is invisible to anyone but the user who minted it",
      (bobNonce?.length ?? 0) === 0);
    const { data: aliceNonce } = await alice.client.from("platform_link_nonces")
      .select("verified_external_id").eq("nonce", nonce).single();
    check("it starts unverified — only the Steam callback may set that",
      aliceNonce?.verified_external_id === null);

    const startRes = await fetch(`${SUPABASE_URL}/functions/v1/steam-link-start`, {
      method: "POST", headers: { apikey: ANON_KEY, "Content-Type": "application/json" },
    });
    check("/steam-link-start refuses an unauthenticated caller", startRes.status === 401,
      String(startRes.status));

    // ---- 4. The import (defect 8b) ----
    console.log("\n4. The import write path");
    const { data: pair } = await admin.from("games").select("id, title").limit(2);
    const [g1, g2] = pair!;

    // The collision case: two store ids, one game. A plain insert dies here.
    const { data: firstRun, error: importError } = await alice.client.rpc("shelf_import_library", {
      p_source: "steam",
      p_items: [
        { game_id: g1.id, uid: "72850", hours: 12.5 },
        { game_id: g1.id, uid: "489830", hours: 30.0 },
        { game_id: g2.id, uid: "1091500", hours: 4.0 },
      ],
    });
    const r1 = (firstRun ?? [])[0] as { inserted: number; updated: number };
    check("two ids resolving to one game do not collide", !importError, importError?.message);
    check("they become one row, not two", r1?.inserted === 2, `inserted ${r1?.inserted}`);
    const { data: merged } = await alice.client.from("library_entries")
      .select("hours_played, source_kind, imported_uid").eq("game_id", g1.id).single();
    check("their playtime is summed (12.5 + 30.0)", Number(merged?.hours_played) === 42.5,
      String(merged?.hours_played));
    check("the row is stamped with its provenance", merged?.source_kind === "steam",
      merged?.source_kind ?? "null");

    // The "do not relitigate the shelf" rule.
    await alice.client.from("library_entries")
      .update({ status: "beaten", rating: 9, notes: "loved it" }).eq("game_id", g2.id);
    const { data: secondRun } = await alice.client.rpc("shelf_import_library", {
      p_source: "steam",
      p_items: [{ game_id: g2.id, uid: "1091500", hours: 6.0 }],
    });
    const r2 = (secondRun ?? [])[0] as { inserted: number; updated: number };
    check("a re-import updates rather than duplicates", r2?.updated === 1, `updated ${r2?.updated}`);
    const { data: kept } = await alice.client.from("library_entries")
      .select("status, rating, notes, hours_played").eq("game_id", g2.id).single();
    check("it does NOT reset a status the user set", kept?.status === "beaten", kept?.status);
    check("nor their rating", kept?.rating === 9, String(kept?.rating));
    check("nor their notes", kept?.notes === "loved it", kept?.notes);
    check("but it does refresh hours on a row the import owns",
      Number(kept?.hours_played) === 6.0, String(kept?.hours_played));

    // A hand-added game the import later also sees must keep being hand-added.
    const { data: g3row } = await admin.from("games").select("id").range(2, 2).single();
    const g3 = g3row!;
    // user_id is explicit because library_entries has NO `default auth.uid()` --
    // wishlist_entries does, and the difference is easy to trip over. Omitting it
    // fails with 23502, and an unchecked failure here would let the next assertion
    // pass for the wrong reason: the import would insert a fresh row rather than
    // taking the conflict path this section exists to test.
    const { error: handAddError } = await alice.client.from("library_entries")
      .insert({ user_id: alice.userId, game_id: g3.id, status: "playing",
                source_kind: "manual", hours_played: 3 });
    check("the hand-added fixture row was really written", !handAddError,
      handAddError?.message);
    await alice.client.rpc("shelf_import_library", {
      p_source: "steam", p_items: [{ game_id: g3.id, uid: "999999", hours: 99 }],
    });
    const { data: handAdded } = await alice.client.from("library_entries")
      .select("status, source_kind, hours_played").eq("game_id", g3.id).single();
    check("a hand-added row keeps source_kind 'manual'", handAdded?.source_kind === "manual",
      handAdded?.source_kind ?? "null");
    check("and keeps its own hours", Number(handAdded?.hours_played) === 3,
      String(handAdded?.hours_played));

    // ---- 5. Disconnect (section 9, rule 2) ----
    console.log("\n5. Disconnect, and whether it means it");
    const { data: removed, error: discError } = await alice.client
      .rpc("shelf_disconnect_platform", { p_platform: "steam" });
    const removedCount = ((removed ?? [])[0] as { removed_entries: number })?.removed_entries;
    check("disconnect succeeds", !discError, discError?.message);
    check("it deletes the untouched imported row", removedCount === 1, `removed ${removedCount}`);

    const { data: survivors } = await alice.client.from("library_entries")
      .select("game_id, status, source_kind");
    const beaten = survivors?.find((r) => r.game_id === g2.id);
    check("a game the user beat is NOT deleted", !!beaten, "the shelf is theirs, not Steam's");
    check("but it stops claiming to come from steam", beaten?.source_kind === "manual",
      beaten?.source_kind ?? "null");
    check("the hand-added row is untouched",
      survivors?.find((r) => r.game_id === g3.id)?.status === "playing");
    const { data: gone } = await alice.client.from("platform_accounts").select("*");
    check("the connection itself is gone", (gone?.length ?? 0) === 0);

    const { error: guardError } = await alice.client
      .rpc("shelf_disconnect_platform", { p_platform: "manual" });
    check("it refuses a platform argument that is really a source_kind", !!guardError,
      "otherwise disconnect('manual') would delete hand-added games");

    // ---- 5a. Re-import AFTER a disconnect (defect 8d — FIXED 15 Sep 2026) ----
    //
    // Was: disconnect sets source_kind='manual' on every row the user had edited,
    // and shelf_import_library's coalesce kept it that way forever — hours froze
    // permanently the moment anyone disconnected and reconnected, which is exactly
    // what the first outside tester reached for when his import looked wrong.
    //
    // Fixed in 20260915150000_reimport_reclaims_hours.sql by replacing
    // 'source_kind = p_source' with a real ownership flag, hours_played_is_own,
    // that survives a disconnect (disconnect never touches it) and is flipped to
    // true only by the library_entries_hours_ownership trigger, the moment
    // anything OTHER than shelf_import_library changes hours_played. See §8d.
    console.log("\n5a. Re-import after a disconnect reclaims the row (defect 8d — see §8d)");
    const { data: rejoin } = await alice.client.rpc("shelf_import_library", {
      p_source: "steam",
      p_items: [{ game_id: g2.id, uid: "1091500", hours: 25.0 }],
    });
    check("the re-import reports touching the row",
      ((rejoin ?? [])[0] as { updated: number })?.updated === 1,
      `updated ${((rejoin ?? [])[0] as { updated: number })?.updated}`);

    const { data: reclaimed } = await alice.client.from("library_entries")
      .select("hours_played, source_kind, imported_uid").eq("game_id", g2.id).single();

    // 6.0 was written before the disconnect; Steam now says 25.0, and this time it
    // sticks.
    check("FIXED: hours refresh after a disconnect+reconnect — 6.0 -> 25.0",
      Number(reclaimed?.hours_played) === 25.0, String(reclaimed?.hours_played));
    check("FIXED: the row rejoins 'steam'",
      reclaimed?.source_kind === "steam", reclaimed?.source_kind ?? "null");
    check("and imported_uid matches the new import, so provenance agrees with itself",
      reclaimed?.imported_uid === "1091500", reclaimed?.imported_uid ?? "null");

    // But the "do not relitigate the shelf" rule from §4 must still hold: status,
    // rating and notes were never touched by any of this.
    const { data: stillBeaten } = await alice.client.from("library_entries")
      .select("status, rating, notes").eq("game_id", g2.id).single();
    check("status/rating/notes survived the reclaim untouched",
      stillBeaten?.status === "beaten" && stillBeaten?.rating === 9 && stillBeaten?.notes === "loved it",
      JSON.stringify(stillBeaten));

    // ---- 5b. A human editing hours directly still wins, RPC or no RPC ----
    //
    // library_entries carries an "own rows, all operations" RLS policy, so the app
    // can PATCH hours_played without going through shelf_import_library at all.
    // The ownership flag has to catch that path too, or a user's own edit would
    // look identical to an import's stale figure and get silently overwritten on
    // the next sync.
    console.log("\n5b. A direct edit to hours_played is never overwritten by a later import");
    const { error: patchError } = await alice.client.from("library_entries")
      .update({ hours_played: 40 }).eq("game_id", g2.id);
    check("the direct edit was written", !patchError, patchError?.message);

    const { data: afterImportAgain } = await alice.client.rpc("shelf_import_library", {
      p_source: "steam", p_items: [{ game_id: g2.id, uid: "1091500", hours: 60.0 }],
    });
    check("the RPC still reports touching the row",
      ((afterImportAgain ?? [])[0] as { updated: number })?.updated === 1);
    const { data: stillHuman } = await alice.client.from("library_entries")
      .select("hours_played").eq("game_id", g2.id).single();
    check("but hours stayed at the human's 40, not the import's 60",
      Number(stillHuman?.hours_played) === 40, String(stillHuman?.hours_played));

    // ---- 6. The deployed endpoints ----
    //
    // Everything above drives the database directly. This drives the live functions,
    // because a migration that applies and a function that deploys are two different
    // facts -- on 8 Sep a deploy landed ahead of its migration and left share-resolve
    // calling an RPC that did not exist.
    console.log("\n6. The deployed endpoints");
    const fnBase = `${SUPABASE_URL}/functions/v1`;
    const aliceToken = (await alice.client.auth.getSession()).data.session!.access_token;
    const authed = (body?: unknown) => ({
      method: "POST",
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${aliceToken}`,
                 "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    const start = await fetch(`${fnBase}/steam-link-start`, authed());
    const startBody = await start.json() as { redirectUrl?: string; nonce?: string };
    check("/steam-link-start returns a redirect", start.status === 200, String(start.status));
    const redirect = startBody.redirectUrl ?? "";
    check("it points at Steam's OpenID endpoint",
      redirect.startsWith("https://steamcommunity.com/openid/login?"), redirect.slice(0, 60));
    const rp = new URL(redirect).searchParams;
    check("return_to is under the realm Steam is given",
      (rp.get("openid.return_to") ?? "").startsWith(rp.get("openid.realm") ?? "\u0000"),
      `${rp.get("openid.realm")} / ${rp.get("openid.return_to")}`);
    check("it asks Steam to identify the user rather than claiming to know them",
      rp.get("openid.identity") === "http://specs.openid.net/auth/2.0/identifier_select");

    // Steam itself must accept the request. A 200 on its sign-in page means the
    // realm/return_to pair passed Valve's validation; an error page means it did not.
    const steamPage = await fetch(redirect, { redirect: "follow" });
    const steamHtml = await steamPage.text();
    check("Steam accepts the redirect and serves its sign-in page",
      steamPage.ok && !/is not valid|error/i.test(steamHtml.slice(0, 4000)),
      String(steamPage.status));

    // The callback must be reachable with NO JWT -- it is the one function deployed
    // --no-verify-jwt, and if that flag was missed Steam's redirect would 401.
    const cb = await fetch(
      `${fnBase}/steam-link-callback?nonce=${encodeURIComponent(startBody.nonce ?? "x")}`,
      { redirect: "manual" });
    check("/steam-link-callback is reachable without a JWT (--no-verify-jwt)",
      cb.status !== 401, String(cb.status));
    const location = cb.headers.get("location") ?? "";
    check("it 302s back into the app rather than rendering anything",
      cb.status === 302, `${cb.status} ${location}`);
    check("APP_LINK_RETURN_URL is set to the app's real scheme",
      location.startsWith("prysm://"), location || "(no location header)");
    check("unsigned openid params are rejected — status=failed, not ok",
      location.includes("status=failed"), location);

    const unverified = await fetch(`${fnBase}/steam-link-finish`,
      authed({ nonce: startBody.nonce }));
    check("/steam-link-finish refuses a nonce Steam never confirmed",
      unverified.status === 409, String(unverified.status));

    const noAccount = await fetch(`${fnBase}/steam-import`, authed());
    check("/steam-import refuses when nothing is linked", noAccount.status === 409,
      String(noAccount.status));

    // ---- 7. A real import, end to end ----
    //
    // st4ck is a public 4,652-game profile. Linking it by hand skips only the OpenID
    // handshake (which needs a human at Steam's page); everything after it -- the
    // real Steam API call, the resolve, the dedupe, the write -- runs for real.
    console.log("\n7. A real 4,652-game import through the live endpoint");
    await alice.client.from("platform_accounts").upsert({
      user_id: alice.userId, platform: "steam", external_id: "76561198023414915",
    }, { onConflict: "user_id,platform" });

    const t0 = Date.now();
    const imported = await fetch(`${fnBase}/steam-import`, authed());
    const elapsed = Date.now() - t0;
    const res = await imported.json() as
      { total: number; matched: number; inserted: number; viaParent: number };
    check("the import succeeds", imported.status === 200, JSON.stringify(res).slice(0, 200));
    // 4,667 once skip_unvetted_apps=0 is deployed; 4,652 before it. A range rather
    // than an equality because Valve vets apps continuously and this account keeps
    // buying games — an exact number here would fail for a reason that is not a bug.
    // The floor is what matters: a sharp drop means a dropped parameter or a
    // re-introduced row cap.
    check("it sees the whole library", res.total >= 4652, String(res.total));
    check("unvetted apps are included (skip_unvetted_apps=0 is deployed)",
      res.total >= 4667, `${res.total} — 4652 means the old build is still deployed`);
    check("it matches the measured share of it", res.matched > 1700 && res.matched < 1900,
      `${res.matched} matched`);
    check("dedupe collapsed editions onto shared parents",
      res.inserted < res.matched, `${res.inserted} rows from ${res.matched} appids`);
    check("the parent hop contributed", res.viaParent > 0, `${res.viaParent} via parent`);
    check("it fits inside an edge function's budget", elapsed < 150_000, `${(elapsed / 1000).toFixed(1)}s`);

    // g1 (section 4) and g2 (section 5a, reclaimed by the defect-8d fix) also carry
    // source_kind='steam' on this same account, and are unrelated to this import --
    // excluded, or a synthetic fixture would inflate a count this check exists to
    // pin exactly.
    const { count: written } = await alice.client.from("library_entries")
      .select("*", { count: "exact", head: true })
      .eq("source_kind", "steam")
      .not("game_id", "in", `(${g1.id},${g2.id})`);
    check("the rows are really in the library", (written ?? 0) === res.inserted,
      `${written} rows`);
    const { data: longest } = await alice.client.from("library_entries")
      .select("hours_played").order("hours_played", { ascending: false }).limit(1).single();
    check("the 9,120h row survived the clamp", Number(longest?.hours_played) === 9120.6,
      String(longest?.hours_played));

    // ---- 8. Android import — a direct join, no OAuth, no human needed ----
    //
    // Unlike Xbox, this is fully testable without a live account: the "auth" is
    // on-device package detection, which the app simulates here by simply posting
    // real android-sourced uids from game_external_ids. §7: IGDB source 15 stores
    // the Play Store package name verbatim, so this is the same direct-join shape
    // as Steam, just with no handshake in front of it and no playtime behind it.
    console.log("\n8. Android import (direct join, no handshake)");
    const { data: androidEdges, error: androidEdgeError } = await admin
      .from("game_external_ids").select("uid, game_id").eq("source", "android").limit(3);
    check("the android edges exist to test against", !androidEdgeError && (androidEdges?.length ?? 0) >= 2,
      androidEdgeError?.message ?? `${androidEdges?.length ?? 0} edges`);

    if ((androidEdges?.length ?? 0) >= 2) {
      const rows = androidEdges! as { uid: string; game_id: string }[];
      const bogus = "com.shelf.verify.nonexistent.package.does.not.exist";

      const imported = await fetch(`${fnBase}/android-import`, authed({
        packages: [rows[0].uid, rows[1].uid, rows[0].uid, bogus],
      }));
      const res = await imported.json() as { total: number; matched: number; inserted: number; unmatched: string[] };
      check("/android-import succeeds", imported.status === 200, JSON.stringify(res));
      check("the duplicate package collapses before resolving (3 unique, not 4)",
        res.total === 3, `total ${res.total}`);
      check("the two real packages resolve", res.matched === 2, `matched ${res.matched}`);
      check("the bogus package is reported unmatched", res.unmatched.includes(bogus),
        JSON.stringify(res.unmatched));

      const { data: androidRows } = await alice.client.from("library_entries")
        .select("game_id, source_kind, hours_played, imported_uid")
        .in("game_id", [rows[0].game_id, rows[1].game_id]);
      check("both rows landed with source_kind 'android'",
        (androidRows ?? []).every((r) => r.source_kind === "android"), JSON.stringify(androidRows));
      check("hours is 0 — package detection carries no playtime",
        (androidRows ?? []).every((r) => Number(r.hours_played) === 0), JSON.stringify(androidRows));

      const badBody = await fetch(`${fnBase}/android-import`, authed({ packages: "not-an-array" }));
      check("a malformed body is rejected, not 500'd", badBody.status === 400, String(badBody.status));

      const { data: androidRemoved } = await alice.client
        .rpc("shelf_disconnect_platform", { p_platform: "android" });
      const androidRemovedCount = ((androidRemoved ?? [])[0] as { removed_entries: number })?.removed_entries;
      check("disconnect('android') removes the untouched imported rows",
        androidRemovedCount === 2, `removed ${androidRemovedCount}`);
    }

  } finally {
    await removeAccounts([alice, bob]);
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
