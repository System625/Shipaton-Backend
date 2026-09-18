// Exercises onboarding steps 4 and 5 against real signed JWTs:
//   - profiles.platforms writes through the existing own-row UPDATE policy, and
//     nothing else's row,
//   - shelf_suggested_users' ranking, blocks, follows and platform/hours columns.
//
// Same reasoning as verify-friend-discovery.ts: shelf_suggested_users is SECURITY
// DEFINER over an owner-only table, so the service-role client would pass every
// filter whether it existed or not. Every assertion runs through a real session.
//
// Creates several users and removes them at the end. Safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUpWithProfile, removeAccounts, makeChecker, type Account } from "./social-accounts.ts";

const { check, finish } = makeChecker();
const RPC = "shelf_suggested_users";

async function main() {
  console.log(`\nOnboarding (steps 4 & 5) verification\n`);

  // Ten catalog games, so each fixture below gets games of its own rather than
  // sharing rows and hoping the previous assertion still meant something.
  const { data: games, error: gamesErr } = await admin
    .from("games").select("id, title").not("cover_url", "is", null).limit(10);
  if (gamesErr || (games?.length ?? 0) < 10) {
    throw new Error(`need 10 catalog games: ${gamesErr?.message ?? `${games?.length} found`}`);
  }
  const [g0, g1, g2, g3, g4, g5, g6, g7, g8, g9] = games!;

  const viewer   = await signUpWithProfile("ov", "Viewer");
  const other    = await signUpWithProfile("oo", "Other");        // for the cross-row write test
  const thin     = await signUpWithProfile("ot", "Thin");         // 1 game, shares one with viewer
  const big      = await signUpWithProfile("ob", "Big");          // 5 games, shares none
  const overlap  = await signUpWithProfile("ol", "Overlap");      // shares exactly 2 with viewer
  const platA    = await signUpWithProfile("pa", "Plat Shares");  // shares viewer's platform
  const platB    = await signUpWithProfile("pb", "Plat Bare");    // same library size, no shared platform
  const hoursAcc = await signUpWithProfile("oh", "Hours");        // library_count/hours_played fixture
  const noHours  = await signUpWithProfile("on", "No Hours");     // all-null hours -> sum is null
  const followed = await signUpWithProfile("of", "Followed");     // already followed, then unfollowed
  const blocked  = await signUpWithProfile("ok", "Blocked");      // blocked both directions
  const skipper  = await signUpWithProfile("os", "Skipper");      // never sets platforms

  const everyone = [
    viewer, other, thin, big, overlap, platA, platB, hoursAcc, noHours, followed, blocked, skipper,
  ];

  const anon = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const shelve = async (acct: Account, gameId: string, hours?: number) => {
      const { error } = await acct.client.from("library_entries")
        .insert({ user_id: acct.userId, game_id: gameId, status: "playing", hours_played: hours ?? null });
      if (error) throw new Error(`shelve for ${acct.handle}: ${error.message}`);
    };

    // ---- 1. profiles.platforms: the write path ----
    console.log("1. Platform preference writes");

    const { data: freshRead } = await other.client
      .from("profiles").select("platforms").eq("user_id", other.userId).single();
    check("a fresh profile insert that omits the field reads back [], not null",
      Array.isArray(freshRead?.platforms) && freshRead?.platforms.length === 0,
      JSON.stringify(freshRead?.platforms));

    const { error: ownWriteErr } = await viewer.client
      .from("profiles").update({ platforms: ["pc", "mobile"] }).eq("user_id", viewer.userId);
    const { data: viewerRow } = await viewer.client
      .from("profiles").select("platforms").eq("user_id", viewer.userId).single();
    check("a signed-in user writes platforms to their own row with a plain .update()",
      !ownWriteErr && viewerRow?.platforms?.sort().join(",") === "mobile,pc",
      ownWriteErr?.message ?? JSON.stringify(viewerRow?.platforms));

    const { data: crossWriteData } = await viewer.client
      .from("profiles").update({ platforms: ["xbox"] }).eq("user_id", other.userId).select();
    const { data: otherAfter } = await other.client
      .from("profiles").select("platforms").eq("user_id", other.userId).single();
    check("the same user writing another user's row touches nothing",
      (crossWriteData?.length ?? 0) === 0 && otherAfter?.platforms?.length === 0,
      JSON.stringify(otherAfter?.platforms));

    const { error: invalidErr } = await viewer.client
      .from("profiles").update({ platforms: ["switch"] }).eq("user_id", viewer.userId);
    check("an invalid platform value is rejected as 23514",
      invalidErr?.code === "23514", invalidErr?.code ?? "no error");

    // ---- 2. Fixtures for the ranking ----
    console.log("\n2. Setting up shelves and platforms");

    await shelve(viewer, g0.id);
    await shelve(viewer, g1.id);

    await shelve(thin, g0.id);                                        // 1 game, shares g0

    for (const g of [g2, g3, g4, g5, g6]) await shelve(big, g.id);     // 5 games, no overlap

    await shelve(overlap, g0.id); await shelve(overlap, g1.id); await shelve(overlap, g2.id); // shares 2

    for (const g of [g2, g3, g4]) await shelve(platA, g.id);           // 3 games, no overlap
    await platA.client.from("profiles").update({ platforms: ["pc"] }).eq("user_id", platA.userId);

    for (const g of [g5, g6, g7]) await shelve(platB, g.id);           // 3 games, no overlap, no shared platform

    await shelve(hoursAcc, g2.id, 10.5);
    await shelve(hoursAcc, g3.id, 5.5);
    await shelve(hoursAcc, g4.id);

    await shelve(noHours, g8.id);
    await shelve(noHours, g9.id);
    await shelve(noHours, g2.id);

    await viewer.client.from("follows").insert({ follower_id: viewer.userId, followee_id: followed.userId });
    await viewer.client.from("user_blocks").insert({ blocker_id: viewer.userId, blocked_id: blocked.userId });

    // ---- 3. The ranked list ----
    console.log("\n3. shelf_suggested_users ranking");

    const { data: list, error: listErr } = await viewer.client.rpc(RPC, { max_results: 50 });
    check("a fresh account gets a non-empty list that excludes itself",
      !listErr && (list?.length ?? 0) > 0 && !list?.some((r: any) => r.user_id === viewer.userId),
      listErr?.message ?? `${list?.length} rows`);

    check("an already-followed account is absent",
      !list?.some((r: any) => r.user_id === followed.userId));

    check("a blocked account is absent",
      !list?.some((r: any) => r.user_id === blocked.userId));

    const { data: blockedSide } = await blocked.client.rpc(RPC, { max_results: 50 });
    check("the block hides the blocker from the blocked account too",
      !blockedSide?.some((r: any) => r.user_id === viewer.userId));

    await viewer.client.from("follows").delete()
      .eq("follower_id", viewer.userId).eq("followee_id", followed.userId);
    const { data: afterUnfollow } = await viewer.client.rpc(RPC, { max_results: 50 });
    check("unfollowing brings the account back",
      afterUnfollow?.some((r: any) => r.user_id === followed.userId));

    const overlapRow = list?.find((r: any) => r.user_id === overlap.userId);
    check("games_in_common is exact for a known overlap",
      overlapRow?.games_in_common === 2, JSON.stringify(overlapRow));

    const bigRow = list?.find((r: any) => r.user_id === big.userId);
    check("games_in_common is 0 for a candidate sharing nothing",
      bigRow?.games_in_common === 0, JSON.stringify(bigRow));

    const { count: directLibraryCount } = await admin
      .from("library_entries").select("*", { count: "exact", head: true }).eq("user_id", hoursAcc.userId);
    const { data: directHours } = await admin
      .from("library_entries").select("hours_played").eq("user_id", hoursAcc.userId);
    const expectedHours = directHours!
      .reduce((sum, r) => sum + (r.hours_played == null ? 0 : Number(r.hours_played)), 0);
    const hoursRow = list?.find((r: any) => r.user_id === hoursAcc.userId);
    check("library_count matches a direct service-role count",
      hoursRow?.library_count === directLibraryCount, JSON.stringify(hoursRow));
    check("hours_played matches the direct sum",
      hoursRow?.hours_played != null && Math.abs(Number(hoursRow.hours_played) - expectedHours) < 0.01,
      JSON.stringify(hoursRow));

    const noHoursRow = list?.find((r: any) => r.user_id === noHours.userId);
    check("hours_played is null, not 0, when no entry carries hours",
      noHoursRow != null && noHoursRow.hours_played === null, JSON.stringify(noHoursRow));

    const thinIdx = list?.findIndex((r: any) => r.user_id === thin.userId) ?? -1;
    const bigIdx  = list?.findIndex((r: any) => r.user_id === big.userId) ?? -1;
    check("a thin shelf (< 3 games) sorts after a bigger one even when it shares a game",
      thinIdx >= 0 && bigIdx >= 0 && thinIdx > bigIdx, `thin@${thinIdx} big@${bigIdx}`);

    const platAIdx = list?.findIndex((r: any) => r.user_id === platA.userId) ?? -1;
    const platBIdx = list?.findIndex((r: any) => r.user_id === platB.userId) ?? -1;
    check("an equal-library candidate sharing the viewer's platform outranks one that doesn't",
      platAIdx >= 0 && platBIdx >= 0 && platAIdx < platBIdx, `platA@${platAIdx} platB@${platBIdx}`);

    const { data: skipperList, error: skipperErr } = await skipper.client.rpc(RPC, { max_results: 50 });
    check("a viewer who skipped step 4 (platforms = '{}') still gets a full list",
      !skipperErr && (skipperList?.length ?? 0) > 0, skipperErr?.message);

    // ---- 4. Grants ----
    console.log("\n4. Grants");

    const { error: anonErr } = await anon.rpc(RPC, { max_results: 5 });
    check("anon cannot execute shelf_suggested_users", anonErr !== null, anonErr?.code ?? "no error");

  } finally {
    await removeAccounts(everyone);
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
