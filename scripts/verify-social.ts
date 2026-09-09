// Exercises the DEPLOYED social graph and feed against real signed JWTs.
//
// There are no edge functions here. Posts, likes, comments, follows and profiles are
// ordinary tables reached through PostgREST with RLS doing the enforcement, plus two
// read functions (shelf_feed, shelf_profile_stats). That is a deliberate departure from
// "every endpoint is an edge function": these are CRUD on rows owned by the caller, and
// a function per verb would be six deploys carrying no logic. The security therefore
// lives entirely in the policies -- which is exactly why this script spends most of its
// checks trying to get at rows it should not be allowed to see.
//
// Creates three users and removes them again. Safe to re-run.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");

const RUN = Date.now();
const PASSWORD = `Shelf-social-${RUN}!`;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

type Account = { userId: string; handle: string; client: SupabaseClient };

async function signUp(tag: string): Promise<Account> {
  const email = `verify+social-${tag}-${RUN}@shelf.test`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  // Handles are lowercase and 3-20 chars; the run stamp keeps re-runs from colliding.
  const handle = `v${tag}${RUN}`.toLowerCase().slice(0, 20);
  return { userId: created.user!.id, handle, client };
}

async function main() {
  console.log(`\nDeployed social verification against ${SUPABASE_URL}\n`);

  const alice = await signUp("a");
  const bob = await signUp("b");
  const carol = await signUp("c");

  try {
    // ---- 1. Profiles ----
    console.log("1. Profiles");
    for (const [who, acct] of [["alice", alice], ["bob", bob], ["carol", carol]] as const) {
      const { error } = await acct.client.from("profiles").insert({
        user_id: acct.userId, handle: acct.handle, display_name: `${who} test`,
        avatar_color: "green",
      });
      check(`${who} can create their own profile`, !error, error?.message ?? "");
    }

    const { error: stolen } = await alice.client.from("profiles")
      .insert({ user_id: bob.userId, handle: `x${RUN}`.slice(0, 20), display_name: "not bob" });
    check("cannot create a profile for someone else", !!stolen, stolen?.code ?? "no error");

    const { error: dupe } = await alice.client.from("profiles")
      .update({ handle: bob.handle }).eq("user_id", alice.userId);
    check("a taken handle is rejected", !!dupe, dupe?.code ?? "no error");

    const { error: badHandle } = await alice.client.from("profiles")
      .update({ handle: "No Spaces!" }).eq("user_id", alice.userId);
    check("a malformed handle is rejected", !!badHandle, badHandle?.code ?? "no error");

    const { data: renamed } = await bob.client.from("profiles")
      .update({ display_name: "Bob Renamed" }).eq("user_id", bob.userId).select().single();
    check("own profile is updatable", renamed?.display_name === "Bob Renamed");

    const { data: others } = await alice.client.from("profiles")
      .update({ display_name: "hacked" }).eq("user_id", bob.userId).select();
    check("another profile is not updatable", (others?.length ?? 0) === 0,
      `${others?.length ?? 0} rows changed`);

    // ---- 2. Follows ----
    console.log("\n2. Follows");
    const { error: followErr } = await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: bob.userId });
    check("alice can follow bob", !followErr, followErr?.message ?? "");

    const { error: dupFollow } = await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: bob.userId });
    check("following twice is rejected, not duplicated", !!dupFollow, dupFollow?.code ?? "no error");

    const { error: selfFollow } = await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: alice.userId });
    check("self-follow is rejected", !!selfFollow, selfFollow?.code ?? "no error");

    const { error: forged } = await alice.client.from("follows")
      .insert({ follower_id: bob.userId, followee_id: carol.userId });
    check("cannot make someone else follow", !!forged, forged?.code ?? "no error");

    // ---- 3. Posts and the feed ----
    console.log("\n3. Posts and the feed");
    const { data: bobPost, error: postErr } = await bob.client.from("posts")
      .insert({ author_id: bob.userId, body: "Finally beat the final boss after 40 hours.",
                link_url: "https://example.com/clip" })
      .select().single();
    check("bob can post", !postErr && !!bobPost, postErr?.message ?? "");

    const { data: carolPost } = await carol.client.from("posts")
      .insert({ author_id: carol.userId, body: "Anyone else stuck on the water temple?" })
      .select().single();

    const { error: forgedPost } = await alice.client.from("posts")
      .insert({ author_id: bob.userId, body: "posted as bob" });
    check("cannot post as someone else", !!forgedPost, forgedPost?.code ?? "no error");

    const { error: emptyPost } = await alice.client.from("posts")
      .insert({ author_id: alice.userId, body: "   " });
    check("an empty post is rejected", !!emptyPost, emptyPost?.code ?? "no error");

    const { error: badLink } = await alice.client.from("posts")
      .insert({ author_id: alice.userId, body: "bad link", link_url: "javascript:alert(1)" });
    check("a non-http link is rejected", !!badLink, badLink?.code ?? "no error");

    await alice.client.from("posts")
      .insert({ author_id: alice.userId, body: "my own post" });

    const { data: feed, error: feedErr } = await alice.client.rpc("shelf_feed", {});
    check("the feed returns 200", !feedErr, feedErr?.message ?? "");
    const feedIds = (feed ?? []).map((r: any) => r.id);
    check("it contains the post by someone alice follows", feedIds.includes(bobPost!.id));
    check("it contains alice's own post",
      (feed ?? []).some((r: any) => r.author_id === alice.userId));
    check("it does NOT contain a post by someone she does not follow",
      !feedIds.includes(carolPost!.id));

    const bobCard = (feed ?? []).find((r: any) => r.id === bobPost!.id);
    check("the card carries the author's handle", bobCard?.handle === bob.handle, bobCard?.handle);
    check("the card carries the display name", bobCard?.display_name === "Bob Renamed");
    check("the card carries an avatar colour the app can render",
      ["teal","orange","purple","pink","gold","navy","red","green","blue","slate"]
        .includes(bobCard?.avatar_color), bobCard?.avatar_color);

    // ---- 4. Likes ----
    console.log("\n4. Likes");
    await alice.client.from("post_likes").insert({ post_id: bobPost!.id, user_id: alice.userId });
    const { data: liked } = await alice.client.rpc("shelf_feed", {});
    const likedCard = (liked ?? []).find((r: any) => r.id === bobPost!.id);
    check("like_count reflects the like", Number(likedCard?.like_count) === 1,
      String(likedCard?.like_count));
    check("liked_by_me is true for the liker", likedCard?.liked_by_me === true);

    const { data: bobsView } = await bob.client.rpc("shelf_feed", { p_handle: bob.handle });
    const bobsCard = (bobsView ?? []).find((r: any) => r.id === bobPost!.id);
    check("liked_by_me is false for someone who did not like it",
      bobsCard?.liked_by_me === false);

    const { error: forgedLike } = await alice.client.from("post_likes")
      .insert({ post_id: bobPost!.id, user_id: bob.userId });
    check("cannot like as someone else", !!forgedLike, forgedLike?.code ?? "no error");

    await alice.client.from("post_likes").delete()
      .eq("post_id", bobPost!.id).eq("user_id", alice.userId);
    const { data: unliked } = await alice.client.rpc("shelf_feed", {});
    check("unliking removes the like",
      Number((unliked ?? []).find((r: any) => r.id === bobPost!.id)?.like_count) === 0);

    // ---- 5. Comments ----
    console.log("\n5. Comments");
    const { data: comment, error: commentErr } = await alice.client.from("post_comments")
      .insert({ post_id: bobPost!.id, author_id: alice.userId, body: "Worth every minute." })
      .select().single();
    check("alice can comment on bob's post", !commentErr && !!comment, commentErr?.message ?? "");

    const { data: counted } = await alice.client.rpc("shelf_feed", {});
    check("comment_count reflects it",
      Number((counted ?? []).find((r: any) => r.id === bobPost!.id)?.comment_count) === 1);

    const { data: carolDelete } = await carol.client.from("post_comments")
      .delete().eq("id", comment!.id).select();
    check("a stranger cannot delete the comment", (carolDelete?.length ?? 0) === 0);

    const { data: ownerDelete } = await bob.client.from("post_comments")
      .delete().eq("id", comment!.id).select();
    check("the post's owner can delete a comment on it — moderation",
      (ownerDelete?.length ?? 0) === 1);

    // ---- 6. Blocks ----
    console.log("\n6. Blocks");
    await bob.client.from("user_blocks")
      .insert({ blocker_id: bob.userId, blocked_id: alice.userId });

    const { data: afterBlock } = await alice.client.rpc("shelf_feed", {});
    check("a blocked viewer no longer sees the blocker's post",
      !(afterBlock ?? []).map((r: any) => r.id).includes(bobPost!.id));

    const { data: directRead } = await alice.client.from("posts").select().eq("id", bobPost!.id);
    check("nor can she read it directly through PostgREST", (directRead?.length ?? 0) === 0);

    const { data: blockList } = await alice.client.from("user_blocks").select();
    check("a block list is invisible to the person blocked", (blockList?.length ?? 0) === 0);

    const { error: blockedComment } = await alice.client.from("post_comments")
      .insert({ post_id: bobPost!.id, author_id: alice.userId, body: "still here" });
    check("and she cannot comment on it", !!blockedComment, blockedComment?.code ?? "no error");

    await bob.client.from("user_blocks").delete()
      .eq("blocker_id", bob.userId).eq("blocked_id", alice.userId);

    // ---- 7. Reports ----
    console.log("\n7. Reports");
    const { error: reportErr } = await carol.client.from("content_reports").insert({
      reporter_id: carol.userId, target_type: "post", target_id: bobPost!.id,
      reason: "spam link",
    });
    check("anyone can report content", !reportErr, reportErr?.message ?? "");
    const { data: alicesReports } = await alice.client.from("content_reports").select();
    check("reports are not readable by other users", (alicesReports?.length ?? 0) === 0);

    // ---- 8. Profile stats ----
    console.log("\n8. Profile stats");
    const { data: stats } = await alice.client.rpc("shelf_profile_stats", { p_handle: bob.handle });
    const s = (stats ?? [])[0];
    check("followers counts alice", Number(s?.followers) === 1, String(s?.followers));
    check("post_count counts bob's post", Number(s?.post_count) === 1, String(s?.post_count));
    check("followed_by_me is true", s?.followed_by_me === true);
    check("is_me is false when viewing someone else", s?.is_me === false);
    const { data: upper } = await alice.client.rpc("shelf_profile_stats",
      { p_handle: bob.handle.toUpperCase() });
    check("handle lookup is case-insensitive", (upper ?? []).length === 1);

    // ---- 9. The isolation that must NOT have widened ----
    // Everything above opens rows to other users for the first time. These two checks
    // exist to prove the private half of the schema is exactly as private as it was.
    console.log("\n9. Library and share intake are still owner-only");
    const { data: game } = await admin.from("games").select("id").limit(1).single();
    await admin.from("library_entries").insert({
      user_id: bob.userId, game_id: game!.id, status: "backlog",
    });
    const { data: peek } = await alice.client.from("library_entries").select()
      .eq("user_id", bob.userId);
    check("a follower cannot read the library of the person they follow",
      (peek?.length ?? 0) === 0, `${peek?.length ?? 0} rows`);

    await admin.from("share_intake").insert({
      user_id: bob.userId, raw_url: "https://www.tiktok.com/@x/video/1", provider: "tiktok",
    });
    const { data: peekShares } = await alice.client.from("share_intake").select()
      .eq("user_id", bob.userId);
    check("nor their share history", (peekShares?.length ?? 0) === 0,
      `${peekShares?.length ?? 0} rows`);
  } finally {
    for (const acct of [alice, bob, carol]) {
      await admin.auth.admin.deleteUser(acct.userId);
    }
    console.log("\ncleaned up test users.");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
