// Exercises the DEPLOYED notification inbox against real signed JWTs.
//
// Nothing here is a client write: every row is produced by a trigger, and there is no
// INSERT or UPDATE policy on `notifications` at all. So the checks fall into three
// groups -- that the triggers fire on the three things that should ring the bell, that
// they stay quiet for the things that should not (your own like, a blocked account, a
// repeated follow), and that a client cannot reach the table except to read, dismiss,
// and mark its own rows read.
//
// Creates three users and removes them again. Safe to re-run.

import { admin } from "./supabase-admin.ts";
import { signUpWithProfile, removeAccounts, makeChecker, type Account } from "./social-accounts.ts";

const { check, finish } = makeChecker();

async function inbox(acct: Account, args: Record<string, unknown> = {}) {
  const { data, error } = await acct.client.rpc("shelf_notifications", args);
  if (error) throw new Error(`shelf_notifications: ${error.message}`);
  return (data ?? []) as any[];
}

async function unread(acct: Account): Promise<number> {
  const { data, error } = await acct.client.rpc("shelf_unread_notification_count");
  if (error) throw new Error(`shelf_unread_notification_count: ${error.message}`);
  return Number(data);
}

async function main() {
  console.log(`\nDeployed notification verification\n`);

  const alice = await signUpWithProfile("na", "Alice Notify");
  const bob   = await signUpWithProfile("nb", "Bob Notify");
  const carol = await signUpWithProfile("nc", "Carol Notify");

  try {
    // ---- 1. Follow ----
    console.log("1. A follow rings the bell");
    await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: bob.userId });

    let bobInbox = await inbox(bob);
    const follow = bobInbox.find((n) => n.kind === "follow");
    check("bob is notified that alice followed him", !!follow);
    check("the row names alice as the actor", follow?.actor_id === alice.userId);
    check("it carries her handle",       follow?.handle === alice.handle, follow?.handle);
    check("it carries her display name", follow?.display_name === "Alice Notify");
    check("it carries an avatar colour the app can render",
      ["teal","orange","purple","pink","gold","navy","red","green","blue","slate"]
        .includes(follow?.avatar_color), follow?.avatar_color);
    check("it arrives unread", follow?.read_at === null);

    await alice.client.from("follows").delete()
      .eq("follower_id", alice.userId).eq("followee_id", bob.userId);
    await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: bob.userId });
    check("unfollowing and refollowing does not ring it again",
      (await inbox(bob)).filter((n) => n.kind === "follow").length === 1);

    // ---- 2. Likes ----
    console.log("\n2. A like rings the bell");
    const { data: post } = await bob.client.from("posts")
      .insert({ author_id: bob.userId, body: "Finally beat the final boss after 40 hours." })
      .select().single();

    await bob.client.from("post_likes").insert({ post_id: post!.id, user_id: bob.userId });
    check("liking your own post does not notify you",
      (await inbox(bob)).filter((n) => n.kind === "post_like").length === 0);
    await bob.client.from("post_likes").delete()
      .eq("post_id", post!.id).eq("user_id", bob.userId);

    await alice.client.from("post_likes").insert({ post_id: post!.id, user_id: alice.userId });
    const like = (await inbox(bob)).find((n) => n.kind === "post_like");
    check("bob is notified that alice liked his post", !!like);
    check("it points at the post", like?.post_id === post!.id);
    check("it carries enough of the post to render a card",
      typeof like?.post_excerpt === "string" && like.post_excerpt.startsWith("Finally beat"),
      like?.post_excerpt);

    await alice.client.from("post_likes").delete()
      .eq("post_id", post!.id).eq("user_id", alice.userId);
    await alice.client.from("post_likes").insert({ post_id: post!.id, user_id: alice.userId });
    check("unliking and reliking does not ring it again",
      (await inbox(bob)).filter((n) => n.kind === "post_like").length === 1);

    // ---- 3. Comments ----
    console.log("\n3. A comment rings the bell");
    await alice.client.from("post_comments")
      .insert({ post_id: post!.id, author_id: alice.userId, body: "Worth every minute." });
    await alice.client.from("post_comments")
      .insert({ post_id: post!.id, author_id: alice.userId, body: "Second thoughts, actually." });
    const comments = (await inbox(bob)).filter((n) => n.kind === "post_comment");
    check("every separate comment notifies, unlike a like", comments.length === 2,
      String(comments.length));
    check("the row carries the comment text",
      comments.some((n) => n.comment_excerpt === "Worth every minute."),
      comments.map((n) => n.comment_excerpt).join(" | "));

    const { data: ownComment } = await bob.client.from("post_comments")
      .insert({ post_id: post!.id, author_id: bob.userId, body: "Replying to myself." })
      .select().single();
    check("commenting on your own post does not notify you",
      (await inbox(bob)).filter((n) => n.kind === "post_comment").length === 2);
    await bob.client.from("post_comments").delete().eq("id", ownComment!.id);

    // ---- 4. The badge ----
    console.log("\n4. The unread count");
    check("it counts every unread row", (await unread(bob)) === 4, String(await unread(bob)));
    check("and is zero for someone with no notifications", (await unread(carol)) === 0);
    check("unread_only filters the inbox",
      (await inbox(bob, { p_unread_only: true })).length === 4);

    // ---- 5. Marking read ----
    console.log("\n5. Marking read");
    const first = (await inbox(bob))[0];
    const { data: markedOne } = await bob.client
      .rpc("shelf_mark_notifications_read", { p_ids: [first.id] });
    check("marking one row read returns 1", Number(markedOne) === 1, String(markedOne));
    check("the badge drops by one", (await unread(bob)) === 3);
    check("re-marking the same row changes nothing",
      Number(await bob.client.rpc("shelf_mark_notifications_read", { p_ids: [first.id] })
        .then((r) => r.data)) === 0);

    const { data: markedAll } = await bob.client.rpc("shelf_mark_notifications_read", {});
    check("marking all read clears the rest", Number(markedAll) === 3, String(markedAll));
    check("the badge is zero", (await unread(bob)) === 0);
    check("the rows are still in the inbox, just read",
      (await inbox(bob)).length === 4 && (await inbox(bob)).every((n) => n.read_at !== null));

    // ---- 6. Isolation ----
    console.log("\n6. One inbox per person");
    check("carol's inbox does not contain bob's notifications",
      (await inbox(carol)).length === 0);
    const { data: peek } = await carol.client.from("notifications")
      .select().eq("user_id", bob.userId);
    check("nor can she read them directly through PostgREST", (peek?.length ?? 0) === 0);

    await alice.client.from("follows")
      .insert({ follower_id: alice.userId, followee_id: carol.userId });
    const carolFirst = (await inbox(carol))[0];
    const { data: crossMark } = await bob.client
      .rpc("shelf_mark_notifications_read", { p_ids: [carolFirst.id] });
    check("bob cannot mark carol's notification read", Number(crossMark) === 0, String(crossMark));
    check("and it is still unread for her", (await unread(carol)) === 1);

    // ---- 7. The table is trigger-only ----
    console.log("\n7. A client cannot write the table");
    const { error: forged } = await carol.client.from("notifications").insert({
      user_id: bob.userId, actor_id: carol.userId, kind: "follow",
    });
    check("nobody can manufacture a notification", !!forged, forged?.code ?? "no error");

    const { error: selfForged } = await carol.client.from("notifications").insert({
      user_id: carol.userId, actor_id: bob.userId, kind: "follow",
    });
    check("not even one addressed to themselves", !!selfForged, selfForged?.code ?? "no error");

    const { data: updated } = await carol.client.from("notifications")
      .update({ kind: "post_like" }).eq("id", carolFirst.id).select();
    check("and cannot rewrite a row it can read", (updated?.length ?? 0) === 0,
      `${updated?.length ?? 0} rows changed`);

    const { data: dismissed } = await carol.client.from("notifications")
      .delete().eq("id", carolFirst.id).select();
    check("but can dismiss its own", (dismissed?.length ?? 0) === 1);

    // ---- 8. Blocks ----
    console.log("\n8. A blocked account cannot reach the bell");
    await bob.client.from("user_blocks")
      .insert({ blocker_id: bob.userId, blocked_id: carol.userId });
    const before = (await inbox(bob)).length;
    await carol.client.from("follows")
      .insert({ follower_id: carol.userId, followee_id: bob.userId });
    check("a follow from a blocked account is silent", (await inbox(bob)).length === before);

    await bob.client.from("user_blocks").delete()
      .eq("blocker_id", bob.userId).eq("blocked_id", carol.userId);

    // ---- 9. Deleting the subject ----
    console.log("\n9. Deleting a post takes its notifications with it");
    await bob.client.from("posts").delete().eq("id", post!.id);
    const left = await inbox(bob);
    check("no notification survives the post it points at",
      left.every((n) => n.kind === "follow"),
      left.map((n) => n.kind).join(", ") || "empty");
  } finally {
    await removeAccounts([alice, bob, carol]);
    console.log("\ncleaned up test users.");
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
