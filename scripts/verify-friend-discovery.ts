// Exercises friend discovery -- user search and the two follow lists -- against real
// signed JWTs.
//
// Same reasoning as verify-social.ts: all three functions read `profiles` and
// `follows`, both of which are readable by any authenticated account, and all three
// filter on blocks. The service-role client in supabase-admin.ts bypasses RLS and
// would pass every block check here whether the filter existed or not, so every
// assertion below is driven through a real session.
//
// Creates five users and removes them at the end. Safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { required } from "./env.ts";
import { signUp, signUpWithProfile, removeAccounts, makeChecker, RUN, type Account }
  from "./social-accounts.ts";

const { check, finish } = makeChecker();

/** signUp() without the profile, so the handle can be chosen rather than generated. */
async function signUpAs(tag: string, handle: string, displayName: string): Promise<Account> {
  const acct = await signUp(tag);
  const { error } = await acct.client.from("profiles").insert({
    user_id: acct.userId, handle, display_name: displayName, avatar_color: "blue",
  });
  if (error) throw new Error(`profile ${handle}: ${error.message}`);
  return { ...acct, handle };
}

async function main() {
  console.log(`\nFriend discovery verification\n`);

  const alice = await signUpWithProfile("fa", "Alice Discovery");
  const bob   = await signUpWithProfile("fb", "Bob Discovery");
  const carol = await signUpWithProfile("fc", "Carol Discovery");

  // The underscore pair. `_` is legal in a handle AND is the LIKE single-character
  // wildcard, so `u_<run>` and `ux<run>` are the same length and differ only at the
  // character that decides whether the escape works.
  const underscore = `u_${RUN}`.slice(0, 20);
  const control    = `ux${RUN}`.slice(0, 20);
  const dan = await signUpAs("fd", underscore, "Dan Underscore");
  const eve = await signUpAs("fe", control,    "Eve Control");

  const accounts = [alice, bob, carol, dan, eve];
  const anon = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ---- 1. Finding somebody ----
    console.log("1. User search");

    // A prefix of Bob's generated handle, long enough to be past the 2-char floor.
    const bobPrefix = bob.handle.slice(0, 6);
    const { data: found, error: findError } = await alice.client
      .rpc("shelf_search_users", { q: bobPrefix });
    check("a handle prefix finds the account", !findError &&
      found?.some((r: any) => r.user_id === bob.userId), findError?.message);

    const bobRow = found?.find((r: any) => r.user_id === bob.userId);
    check("the row carries the profile the list needs",
      bobRow?.handle === bob.handle && bobRow?.display_name === "Bob Discovery" &&
      bobRow?.avatar_color === "green", JSON.stringify(bobRow?.avatar_color));
    check("followed_by_me is false before following", bobRow?.followed_by_me === false);
    check("is_me is false for somebody else", bobRow?.is_me === false);

    const { data: byName } = await alice.client
      .rpc("shelf_search_users", { q: "Bob Disc" });
    check("a display-name prefix finds it too, case-insensitively",
      byName?.some((r: any) => r.user_id === bob.userId));

    const { data: exact } = await alice.client
      .rpc("shelf_search_users", { q: bob.handle.toUpperCase() });
    check("an exact handle matches regardless of case",
      exact?.[0]?.user_id === bob.userId);

    const { data: shortQ } = await alice.client.rpc("shelf_search_users", { q: "a" });
    check("a single character returns nothing rather than half the table",
      shortQ?.length === 0, `${shortQ?.length} rows`);

    const { data: blankQ } = await alice.client.rpc("shelf_search_users", { q: "   " });
    check("whitespace is trimmed and then refused", blankQ?.length === 0);

    const { data: selfQ } = await alice.client
      .rpc("shelf_search_users", { q: alice.handle });
    check("you are not a search result to yourself",
      !selfQ?.some((r: any) => r.user_id === alice.userId), `${selfQ?.length} rows`);

    // ---- 2. The wildcard that would have been a bug ----
    console.log("\n2. LIKE metacharacters in a handle");

    const { data: underscoreHits } = await alice.client
      .rpc("shelf_search_users", { q: underscore.slice(0, 3) });   // "u_<digit>"
    const ids = (underscoreHits ?? []).map((r: any) => r.user_id);
    check("an underscore matches itself, not any character",
      ids.includes(dan.userId) && !ids.includes(eve.userId),
      `dan ${ids.includes(dan.userId)}, eve ${ids.includes(eve.userId)}`);

    const { data: pctHits } = await alice.client.rpc("shelf_search_users", { q: "%%" });
    check("a percent sign matches literally and so finds nothing",
      pctHits?.length === 0, `${pctHits?.length} rows`);

    // ---- 3. The follow lists ----
    console.log("\n3. Followers and following");

    await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: bob.userId });
    await carol.client.from("follows")
      .insert({ follower_id: carol.userId, followee_id: bob.userId });
    await bob.client.from("follows")
      .insert({ follower_id: bob.userId, followee_id: carol.userId });

    const { data: followers, error: followersError } = await alice.client
      .rpc("shelf_followers", { p_handle: bob.handle });
    check("shelf_followers returns the members, not a count",
      !followersError && followers?.length === 2, followersError?.message ?? `${followers?.length}`);
    const meInList = followers?.find((r: any) => r.user_id === alice.userId);
    check("is_me marks the caller inside the list", meInList?.is_me === true);
    check("the list carries followed_at, which is the cursor the next page needs",
      typeof followers?.[0]?.followed_at === "string", `${followers?.[0]?.followed_at}`);

    // Alice now follows Bob, so a fresh search for him must say so -- this is the
    // field that decides whether the row renders "Follow" or "Following".
    const { data: afterFollow } = await alice.client
      .rpc("shelf_search_users", { q: bobPrefix });
    check("followed_by_me flips to true once the caller follows them",
      afterFollow?.find((r: any) => r.user_id === bob.userId)?.followed_by_me === true);

    const { data: following } = await alice.client
      .rpc("shelf_following", { p_handle: bob.handle });
    check("shelf_following returns who they follow", following?.length === 1 &&
      following?.[0]?.user_id === carol.userId, `${following?.length} rows`);

    const { data: byHandleCase } = await alice.client
      .rpc("shelf_followers", { p_handle: bob.handle.toUpperCase() });
    check("p_handle is matched lowercased, like shelf_profile_stats",
      byHandleCase?.length === 2, `${byHandleCase?.length} rows`);

    const { data: noSuch } = await alice.client
      .rpc("shelf_followers", { p_handle: "nobodyatallxyz" });
    check("an unknown handle is an empty list, not an error", noSuch?.length === 0);

    // Keyset pagination: one row, then everything strictly before it.
    const { data: page1 } = await alice.client
      .rpc("shelf_followers", { p_handle: bob.handle, p_limit: 1 });
    check("p_limit is honoured", page1?.length === 1, `${page1?.length} rows`);
    const { data: page2 } = await alice.client.rpc("shelf_followers", {
      p_handle: bob.handle, p_limit: 1,
      p_before: page1?.[0]?.followed_at,
      p_before_id: page1?.[0]?.user_id,
    });
    check("the cursor from page 1 fetches page 2 without repeating it",
      page2?.length === 1 && page2?.[0]?.user_id !== page1?.[0]?.user_id,
      `${page1?.[0]?.user_id} then ${page2?.[0]?.user_id}`);

    const { data: page3 } = await alice.client.rpc("shelf_followers", {
      p_handle: bob.handle, p_limit: 1,
      p_before: page2?.[0]?.followed_at,
      p_before_id: page2?.[0]?.user_id,
    });
    check("paging past the end is an empty list, not an error", page3?.length === 0,
      `${page3?.length} rows`);

    // ---- 4. Blocks apply to all three ----
    console.log("\n4. Blocks");

    await alice.client.from("user_blocks")
      .insert({ blocker_id: alice.userId, blocked_id: carol.userId });

    const { data: afterBlock } = await alice.client
      .rpc("shelf_search_users", { q: carol.handle.slice(0, 6) });
    check("a blocked account is not findable by the blocker",
      !afterBlock?.some((r: any) => r.user_id === carol.userId),
      `${afterBlock?.length} rows`);

    const { data: theirSearch } = await carol.client
      .rpc("shelf_search_users", { q: alice.handle.slice(0, 6) });
    check("and the blocker is not findable by them either",
      !theirSearch?.some((r: any) => r.user_id === alice.userId),
      `${theirSearch?.length} rows`);

    const { data: blockedFollowers } = await alice.client
      .rpc("shelf_followers", { p_handle: bob.handle });
    check("a blocked account drops out of a follower list",
      !blockedFollowers?.some((r: any) => r.user_id === carol.userId),
      `${blockedFollowers?.length} rows`);

    const { data: blockedFollowing } = await alice.client
      .rpc("shelf_following", { p_handle: bob.handle });
    check("and out of a following list",
      !blockedFollowing?.some((r: any) => r.user_id === carol.userId),
      `${blockedFollowing?.length} rows`);

    const { data: stillThere } = await bob.client
      .rpc("shelf_followers", { p_handle: bob.handle });
    check("the block is one-sided: everyone else still sees them",
      stillThere?.some((r: any) => r.user_id === carol.userId),
      `${stillThere?.length} rows`);

    // ---- 5. Grants ----
    // Migration 000700's rule: `create or replace` restores PUBLIC execute and
    // `authenticated` inherits from PUBLIC, so anon silently regains it. This is the
    // check that catches a forgotten revoke.
    console.log("\n5. Grants");

    for (const fn of ["shelf_search_users", "shelf_followers", "shelf_following"]) {
      const args = fn === "shelf_search_users" ? { q: "aa" } : { p_handle: "someone" };
      const { error } = await anon.rpc(fn, args);
      check(`anon cannot execute ${fn}`, error !== null, error?.code ?? "no error");
    }

  } finally {
    await removeAccounts(accounts);
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
