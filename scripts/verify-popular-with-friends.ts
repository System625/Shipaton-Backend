// Exercises the DEPLOYED "popular with friends" aggregate against real signed JWTs.
//
// This is the one function in the project that reads other people's library_entries,
// so most of what follows is not "does it return games" but "does it refuse to return
// them in every case where it should". Specifically:
//
//   * the owner floor (3 distinct followees) actually holds,
//   * 'backlog' and 'dropped' do not count,
//   * an opted-out account contributes nothing,
//   * a blocked account contributes nothing,
//   * the viewer's own shelf does not inflate their own counts,
//   * someone you do not follow contributes nothing,
//   * and the function still cannot be pointed at a named user.
//
// Creates six users and removes them again. Safe to re-run.

import { admin } from "./supabase-admin.ts";
import { signUpWithProfile, removeAccounts, makeChecker, type Account } from "./social-accounts.ts";

const { check, finish } = makeChecker();

const RPC = "shelf_popular_with_friends";

async function main() {
  console.log(`\nDeployed "popular with friends" verification\n`);

  // Six games, so each rule below can be tested on a game of its own rather than by
  // mutating one row and hoping the previous assertion still meant something.
  const { data: games, error: gamesErr } = await admin
    .from("games").select("id, title").not("cover_url", "is", null).limit(6);
  if (gamesErr || (games?.length ?? 0) < 6) {
    throw new Error(`need 6 catalog games: ${gamesErr?.message ?? `${games?.length} found`}`);
  }
  const [g1, g2, g3, g4, g5, g6] = games!;

  const viewer   = await signUpWithProfile("pv", "Viewer");
  const friendA  = await signUpWithProfile("pa", "Friend A");
  const friendB  = await signUpWithProfile("pb", "Friend B");
  const friendC  = await signUpWithProfile("pc", "Friend C");
  const stranger = await signUpWithProfile("ps", "Stranger");
  const blocked  = await signUpWithProfile("pk", "Blocked");
  const everyone = [viewer, friendA, friendB, friendC, stranger, blocked];

  try {
    // The viewer follows three people, and deliberately not the stranger.
    for (const f of [friendA, friendB, friendC, blocked]) {
      const { error } = await viewer.client.from("follows")
        .insert({ follower_id: viewer.userId, followee_id: f.userId });
      if (error) throw new Error(`follow: ${error.message}`);
    }

    // Each account writes its OWN library rows through its own JWT -- which also
    // re-proves the claim in the API reference that library_entries needs no endpoint.
    const shelve = async (acct: Account, gameId: string, status: string) => {
      const { error } = await acct.client.from("library_entries")
        .insert({ user_id: acct.userId, game_id: gameId, status });
      if (error) throw new Error(`shelve ${status} for ${acct.handle}: ${error.message}`);
    };

    console.log("1. Setting up shelves");
    // g1: three followees playing it -> exactly meets the floor.
    for (const f of [friendA, friendB, friendC]) await shelve(f, g1.id, "playing");
    // g2: two followees, one beaten one playing -> one short of the floor.
    await shelve(friendA, g2.id, "beaten");
    await shelve(friendB, g2.id, "playing");
    // g3: three followees, all backlog -> the status is excluded.
    for (const f of [friendA, friendB, friendC]) await shelve(f, g3.id, "backlog");
    // g4: three followees, all dropped -> the status is excluded.
    for (const f of [friendA, friendB, friendC]) await shelve(f, g4.id, "dropped");
    // g5: two followees plus someone the viewer does not follow.
    await shelve(friendA, g5.id, "playing");
    await shelve(friendB, g5.id, "playing");
    await shelve(stranger, g5.id, "playing");
    // g6: two followees plus the viewer's own shelf.
    await shelve(friendA, g6.id, "playing");
    await shelve(friendB, g6.id, "playing");
    await shelve(viewer,  g6.id, "playing");
    console.log("  done");

    const rows = async (client = viewer.client) => {
      const { data, error } = await client.rpc(RPC, {});
      if (error) throw new Error(`${RPC}: ${error.message}`);
      return (data ?? []) as any[];
    };
    const byId = (list: any[], id: string) => list.find((r) => r.id === id);

    // ---- 2. What it returns ----
    console.log("\n2. The aggregate");
    let list = await rows();
    const g1Row = byId(list, g1.id);
    check("a game three followees are playing appears", !!g1Row, g1.title);
    check("friend_count is the number of followees, not entries",
      Number(g1Row?.friend_count) === 3, String(g1Row?.friend_count));

    // ---- 3. What it must not return ----
    console.log("\n3. The exclusions");
    check("a game only two followees have is below the floor", !byId(list, g2.id));
    check("'backlog' does not count as playing it",             !byId(list, g3.id));
    check("'dropped' does not count as playing it",             !byId(list, g4.id));
    check("someone the viewer does not follow does not count",  !byId(list, g5.id));
    check("the viewer's own shelf does not inflate their counts", !byId(list, g6.id));

    // ---- 4. The card the app renders ----
    console.log("\n4. The catalog row");
    check("it carries a title",     typeof g1Row?.title === "string" && g1Row.title.length > 0);
    check("it carries a cover url", !!g1Row?.cover_url);
    check("platforms is an array",  Array.isArray(g1Row?.platforms), typeof g1Row?.platforms);
    check("score is null, not the friend count — CatalogGame reads it as similarity",
      g1Row?.score === null, String(g1Row?.score));

    // ---- 5. The opt-in toggle ----
    console.log("\n5. share_activity");
    await friendC.client.from("profiles")
      .update({ share_activity: false }).eq("user_id", friendC.userId);
    list = await rows();
    check("an opted-out account stops contributing", !byId(list, g1.id),
      `friend_count now ${byId(list, g1.id)?.friend_count ?? "absent"}`);

    const { data: defaults } = await admin.from("profiles")
      .select("share_activity").eq("user_id", friendA.userId).single();
    check("the default is opt-in", defaults?.share_activity === true);

    await friendC.client.from("profiles")
      .update({ share_activity: true }).eq("user_id", friendC.userId);
    check("switching it back restores the count",
      Number(byId(await rows(), g1.id)?.friend_count) === 3);

    // ---- 6. Blocks ----
    console.log("\n6. Blocks");
    await shelve(blocked, g2.id, "playing");   // g2 now has three followees on it
    check("the fourth followee lifts g2 to the floor",
      Number(byId(await rows(), g2.id)?.friend_count) === 3);

    await viewer.client.from("user_blocks")
      .insert({ blocker_id: viewer.userId, blocked_id: blocked.userId });
    check("a blocked account stops contributing", !byId(await rows(), g2.id));

    await admin.from("user_blocks").delete()
      .eq("blocker_id", viewer.userId).eq("blocked_id", blocked.userId);
    await admin.from("user_blocks")
      .insert({ blocker_id: blocked.userId, blocked_id: viewer.userId });
    check("and a block in the OTHER direction does too", !byId(await rows(), g2.id));
    await admin.from("user_blocks").delete()
      .eq("blocker_id", blocked.userId).eq("blocked_id", viewer.userId);

    // ---- 7. The property that makes a DEFINER function in `public` safe ----
    // If this ever starts passing, the function has grown a way to be pointed at a
    // named person, and the whole privacy argument in the migration stops holding.
    console.log("\n7. It cannot be aimed at anyone");
    const { error: aimed } = await viewer.client.rpc(RPC, { p_user_id: friendA.userId });
    check("there is no user-id argument to pass", !!aimed, aimed?.code ?? "no error");
    const { error: floored } = await viewer.client.rpc(RPC, { p_min_owners: 1 });
    check("nor a way to lower the owner floor", !!floored, floored?.code ?? "no error");

    // ---- 8. The line that must NOT have moved ----
    console.log("\n8. library_entries is still owner-only");
    const { data: peek } = await viewer.client.from("library_entries")
      .select().eq("user_id", friendA.userId);
    check("the viewer still cannot read a followee's actual rows",
      (peek?.length ?? 0) === 0, `${peek?.length ?? 0} rows`);

    const { data: anyRows } = await viewer.client.from("library_entries").select("user_id");
    check("nor anyone's rows but their own",
      (anyRows ?? []).every((r: any) => r.user_id === viewer.userId),
      `${(anyRows ?? []).length} rows visible`);

    // ---- 9. The HTTP route ----
    // The RPC returns the raw catalog row. `abbreviation` and `colorKey` are not
    // columns -- they are derived in toCatalogGame() -- so an app calling the RPC
    // directly would render every cover the same grey, silently. These checks are the
    // reason /games/popular-with-friends exists at all, so they matter more than the
    // usual "it returns 200".
    console.log("\n9. GET /games/popular-with-friends");
    const { data: viaHttp, error: httpErr } = await viewer.client.functions
      .invoke("games/popular-with-friends", { method: "GET" });
    check("the endpoint answers", !httpErr, httpErr?.message ?? "");

    const httpRow = (viaHttp ?? []).find((r: any) => r.id === g1.id);
    check("it returns the same game as the RPC", !!httpRow);
    check("shaped as CatalogGame — camelCase, not the raw row",
      httpRow?.coverImageUrl !== undefined && httpRow?.cover_url === undefined);
    check("abbreviation is derived and present",
      typeof httpRow?.abbreviation === "string" && httpRow.abbreviation.length > 0,
      httpRow?.abbreviation);
    check("colorKey is one the app can actually render",
      ["teal","orange","purple","pink","gold","navy","red","green","blue","slate"]
        .includes(httpRow?.colorKey), httpRow?.colorKey);
    check("friendCount rides along as a number",
      httpRow?.friendCount === 3, String(httpRow?.friendCount));
    check("the internal similarity score is not leaked into the response",
      httpRow?.score === undefined);

    const { data: capped } = await viewer.client.functions
      .invoke("games/popular-with-friends?limit=1", { method: "GET" });
    check("limit is honoured", (capped ?? []).length === 1, String((capped ?? []).length));

    const { data: pastEnd } = await viewer.client.functions
      .invoke("games/popular-with-friends?offset=500", { method: "GET" });
    check("paging past the end is an empty array, not an error",
      Array.isArray(pastEnd) && pastEnd.length === 0);
  } finally {
    await removeAccounts(everyone);
    console.log("\ncleaned up test users.");
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
