// Exercises the DEPLOYED friends-feed build (docs/research/friends-feed.md) against
// real signed JWTs: repost notifications, posts.visibility (mutual-follow "friends"
// audience), and shelf_post(p_post_id). Everything here is new since
// 20260918120000_declare_live_social_schema.sql -- category, polls, votes, reposts
// and shares were already live and are exercised by verify:social /
// verify:notifications, not repeated here.
//
// Creates four users and removes them again. Safe to re-run.

import { admin } from "./supabase-admin.ts";
import { signUpWithProfile, removeAccounts, makeChecker, type Account } from "./social-accounts.ts";

const { check, finish } = makeChecker();

async function inbox(acct: Account) {
  const { data, error } = await acct.client.rpc("shelf_notifications", {});
  if (error) throw new Error(`shelf_notifications: ${error.message}`);
  return (data ?? []) as any[];
}

async function feed(acct: Account, args: Record<string, unknown> = {}) {
  const { data, error } = await acct.client.rpc("shelf_feed", args);
  if (error) throw new Error(`shelf_feed: ${error.message}`);
  return (data ?? []) as any[];
}

async function follow(a: Account, b: Account) {
  await a.client.from("follows").insert({ follower_id: a.userId, followee_id: b.userId });
}

async function main() {
  console.log(`\nDeployed friends-feed verification\n`);

  const alice = await signUpWithProfile("fa", "Alice Feed");
  const bob   = await signUpWithProfile("fb", "Bob Feed");
  const carol = await signUpWithProfile("fc", "Carol Feed");
  const dave  = await signUpWithProfile("fd", "Dave Feed");

  try {
    // ---- 1. Reposts ring the bell ----
    console.log("1. Repost notifications");
    const { data: post } = await bob.client.from("posts")
      .insert({ author_id: bob.userId, body: "Finally beat the final boss." })
      .select().single();

    await bob.client.from("post_reposts").insert({ post_id: post!.id, user_id: bob.userId });
    check("self-repost is allowed",
      (await bob.client.from("post_reposts").select().eq("post_id", post!.id).eq("user_id", bob.userId)).data?.length === 1);
    check("but rings nobody's bell",
      (await inbox(bob)).filter((n) => n.kind === "post_repost").length === 0);
    await bob.client.from("post_reposts").delete().eq("post_id", post!.id).eq("user_id", bob.userId);

    await alice.client.from("post_reposts").insert({ post_id: post!.id, user_id: alice.userId });
    let repostNotif = (await inbox(bob)).find((n) => n.kind === "post_repost");
    check("bob is notified that alice reposted his post", !!repostNotif);
    check("it points at the post", repostNotif?.post_id === post!.id);

    await alice.client.from("post_reposts").delete().eq("post_id", post!.id).eq("user_id", alice.userId);
    await alice.client.from("post_reposts").insert({ post_id: post!.id, user_id: alice.userId });
    check("un-repost then re-repost still rings it exactly once",
      (await inbox(bob)).filter((n) => n.kind === "post_repost").length === 1);

    // The "repost" ranking tier surfaces a post to the REPOSTER's followers, not
    // back into the reposter's own feed -- dave follows alice (not bob, the
    // author), so alice's repost is what puts bob's post in dave's feed.
    await follow(dave, alice);
    const { data: daveFeed } = await dave.client.rpc("shelf_feed", {});
    const reposted = (daveFeed ?? []).find((r: any) => r.id === post!.id);
    check("a followed account's repost surfaces the original with reason='repost'",
      reposted?.reason === "repost", reposted?.reason);
    check("reposted_by_handle names the reposter",
      reposted?.reposted_by_handle === alice.handle, reposted?.reposted_by_handle);
    check("repost_count reflects it", reposted?.repost_count === 1, String(reposted?.repost_count));
    check("reposted_by_me is false for someone who didn't repost it themselves",
      reposted?.reposted_by_me === false);

    // reposted_by_me for the reposter herself -- shelf_post rather than shelf_feed,
    // since her own repost of someone else's post is not ranked into her own feed.
    const { data: aliceView } = await alice.client.rpc("shelf_post", { p_post_id: post!.id });
    check("reposted_by_me is true for the reposter herself",
      aliceView?.[0]?.reposted_by_me === true);

    await bob.client.from("user_blocks").insert({ blocker_id: bob.userId, blocked_id: carol.userId });
    const { error: blockedRepost } = await carol.client.from("post_reposts")
      .insert({ post_id: post!.id, user_id: carol.userId });
    check("a blocked account's repost is refused at insert", !!blockedRepost, blockedRepost?.code ?? "no error");
    check("and leaves no notification",
      (await inbox(bob)).filter((n) => n.kind === "post_repost").length === 1);
    await bob.client.from("user_blocks").delete().eq("blocker_id", bob.userId).eq("blocked_id", carol.userId);

    // ---- 2. Mentions ring the bell ----
    console.log("\n2. Mention notifications");
    const { data: mentionPost } = await carol.client.from("posts")
      .insert({ author_id: carol.userId, body: `Hey @${dave.handle}, check this out` })
      .select().single();
    const mentionNotif = (await inbox(dave)).find((n) => n.kind === "post_mention");
    check("dave is notified he was mentioned", !!mentionNotif);
    check("re-editing the body without changing it does not re-notify",
      await (async () => {
        await carol.client.from("posts").update({ body: mentionPost!.body }).eq("id", mentionPost!.id);
        return (await inbox(dave)).filter((n) => n.kind === "post_mention").length === 1;
      })());
    await carol.client.from("posts").update({ body: `Hey @${dave.handle}, edited` }).eq("id", mentionPost!.id);
    check("editing the body and keeping the same mention does not double-notify",
      (await inbox(dave)).filter((n) => n.kind === "post_mention").length === 1);
    check("mentioning yourself does not notify",
      await (async () => {
        await alice.client.from("posts")
          .insert({ author_id: alice.userId, body: `Self note @${alice.handle}` });
        return (await inbox(alice)).filter((n) => n.kind === "post_mention").length === 0;
      })());

    // ---- 3. Visibility ----
    console.log("\n3. posts.visibility -- friends means mutual follow");
    // alice <-> carol: mutual. bob -> carol: one-way (bob follows carol, carol does not follow bob).
    await follow(alice, carol);
    await follow(carol, alice);
    await follow(bob, carol);

    const { data: friendsPostId, error: createErr } = await carol.client
      .rpc("shelf_create_post", { p_body: "friends only test post", p_visibility: "friends" });
    check("shelf_create_post accepts p_visibility", !createErr && !!friendsPostId, createErr?.message ?? "");

    check("present for the author", (await feed(carol)).some((r: any) => r.id === friendsPostId));
    check("present for a mutual follow", (await feed(alice)).some((r: any) => r.id === friendsPostId));
    check("absent for a one-way follower", !(await feed(bob)).some((r: any) => r.id === friendsPostId));
    check("absent for a stranger", !(await feed(dave)).some((r: any) => r.id === friendsPostId));

    const { data: directBob } = await bob.client.from("posts").select().eq("id", friendsPostId);
    check("absent from a one-way follower's direct select too", (directBob?.length ?? 0) === 0);

    check("shelf_create_post defaults to public when p_visibility is omitted",
      await (async () => {
        const { data: defaultId } = await carol.client
          .rpc("shelf_create_post", { p_body: "default visibility test" });
        const { data: row } = await admin.from("posts").select("visibility").eq("id", defaultId).single();
        return row?.visibility === "public";
      })());

    console.log("\n3a. A hidden post's comments, likes and writes");
    const { data: bobComment } = await bob.client.from("post_comments")
      .insert({ post_id: friendsPostId, author_id: bob.userId, body: "can't see this" }).select();
    check("a one-way follower cannot comment on a friends-only post", (bobComment ?? []).length === 0);

    const { error: bobLike } = await bob.client.from("post_likes")
      .insert({ post_id: friendsPostId, user_id: bob.userId });
    check("nor like it", !!bobLike, bobLike?.code ?? "no error");

    const { error: bobRepost } = await bob.client.from("post_reposts")
      .insert({ post_id: friendsPostId, user_id: bob.userId });
    check("nor repost it", !!bobRepost, bobRepost?.code ?? "no error");

    const { data: aliceComment } = await alice.client.from("post_comments")
      .insert({ post_id: friendsPostId, author_id: alice.userId, body: "mutual can see this" }).select();
    check("but a mutual follow can comment on it", (aliceComment ?? []).length === 1);
    const { data: bobReadComment } = await bob.client.from("post_comments")
      .select().eq("post_id", friendsPostId);
    check("and a one-way follower still cannot read that comment by post id",
      (bobReadComment ?? []).length === 0);

    console.log("\n3b. profile stats and reposts respect visibility");
    const { data: bobStats } = await bob.client.rpc("shelf_profile_stats", { p_handle: carol.handle });
    const { data: aliceStats } = await alice.client.rpc("shelf_profile_stats", { p_handle: carol.handle });
    check("post_count excludes the hidden post for a one-way follower",
      Number(bobStats?.[0]?.post_count) < Number(aliceStats?.[0]?.post_count));

    // dave already follows alice (section 1), so alice's repost would normally
    // surface in his feed via the same mechanism just proven above.
    await alice.client.from("post_reposts").insert({ post_id: friendsPostId, user_id: alice.userId });
    const { data: daveFeedAfterRepost } = await dave.client.rpc("shelf_feed", {});
    check("a mutual's repost of the hidden post does not leak it to her other followers",
      !(daveFeedAfterRepost ?? []).some((r: any) => r.id === friendsPostId));

    // ---- 4. shelf_post ----
    console.log("\n4. shelf_post(p_post_id)");
    const { data: viaPost, error: viaPostErr } = await bob.client.rpc("shelf_post", { p_post_id: post!.id });
    check("returns the post", !viaPostErr && (viaPost ?? []).length === 1, viaPostErr?.message ?? "");
    const { data: viaFeedRow } = await bob.client.rpc("shelf_feed", {});
    const feedRow = (viaFeedRow ?? []).find((r: any) => r.id === post!.id);
    const postRow = (viaPost ?? [])[0];
    check("same column set as shelf_feed (anti-drift check)",
      JSON.stringify(Object.keys(postRow ?? {}).sort()) === JSON.stringify(Object.keys(feedRow ?? {}).sort()));
    check("identical field values for the fields both carry",
      postRow.id === feedRow.id && postRow.body === feedRow.body
        && postRow.like_count === feedRow.like_count && postRow.repost_count === feedRow.repost_count);

    const { data: hiddenViaPost } = await bob.client.rpc("shelf_post", { p_post_id: friendsPostId });
    check("empty for a post the caller may not see", (hiddenViaPost ?? []).length === 0);
    const { data: visibleViaPost } = await alice.client.rpc("shelf_post", { p_post_id: friendsPostId });
    check("present for a mutual follow", (visibleViaPost ?? []).length === 1);

    // Poll block matches shelf_poll's own shape.
    const { data: pollPostId } = await bob.client
      .rpc("shelf_create_post", { p_body: "pick one", p_poll_options: ["one", "two"] });
    const { data: pollViaPost } = await bob.client.rpc("shelf_post", { p_post_id: pollPostId });
    check("the poll block is present via shelf_post",
      !!(pollViaPost?.[0]?.poll?.options?.length === 2), JSON.stringify(pollViaPost?.[0]?.poll));
  } finally {
    await removeAccounts([alice, bob, carol, dave]);
    console.log("\ncleaned up test users.");
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
