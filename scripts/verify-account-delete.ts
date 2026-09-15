// Exercises POST /account-delete against a real signed JWT.
//
// This is the one endpoint with no undo, so the check that matters is not "did it
// return 200" but "is every trace of that account actually gone" -- which is asserted
// afterwards with the SERVICE ROLE, deliberately. Every other verification script
// avoids the admin client because it bypasses RLS; here that is exactly the point. A
// check driven through the user's own session could not tell "the row is deleted"
// apart from "the row is now invisible to me", and those are very different outcomes
// for a deletion endpoint.
//
// Creates two users. The one under test deletes itself; the other is removed at the
// end. Safe to re-run.

import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUpWithProfile, removeAccounts, makeChecker, type Account }
  from "./social-accounts.ts";

const { check, finish } = makeChecker();
const FUNCTIONS = `${required("SUPABASE_URL")}/functions/v1`;
const BUCKET = "post-images";

async function tokenFor(acct: Account): Promise<string> {
  const { data } = await acct.client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("no access token on the session");
  return token;
}

async function callDelete(token: string, body: unknown) {
  const res = await fetch(`${FUNCTIONS}/account-delete`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function main() {
  console.log(`\nAccount deletion verification against ${FUNCTIONS}\n`);

  const doomed = await signUpWithProfile("da", "Doomed Account");
  const other  = await signUpWithProfile("db", "Surviving Account");
  let doomedGone = false;

  try {
    // ---- 1. Give the account something to lose ----
    console.log("1. Seeding the account");

    const { data: games } = await admin.from("games").select("id").limit(1);
    const gameId = games?.[0]?.id;
    if (!gameId) throw new Error("catalog is empty");

    // Seeding must fail loudly. An insert whose error is ignored here produces a
    // deletion test that passes because there was nothing to delete, which is the
    // worst possible way for this particular script to be green.
    const seed = async (label: string, p: PromiseLike<{ error: unknown }>) => {
      const { error } = await p;
      if (error) throw new Error(`seeding ${label}: ${JSON.stringify(error)}`);
    };

    // EVERY owner column here is sent explicitly. Only `wishlist_entries.user_id`
    // and `recently_viewed.user_id` default to auth.uid() -- library_entries, posts,
    // post_likes and follows all require it from the caller, and omitting it fails
    // the RLS WITH CHECK with 42501 rather than defaulting to anything.
    await seed("library_entries", doomed.client.from("library_entries")
      .insert({ user_id: doomed.userId, game_id: gameId, status: "backlog" }));
    await seed("wishlist_entries", doomed.client.from("wishlist_entries")
      .insert({ user_id: doomed.userId, game_id: gameId }));
    // A browsing history is recorded for the user rather than created by them, so
    // "delete my account" covering it is not optional. Seeded through the same RPC
    // the /games/:id route calls, so this asserts the real write path.
    await seed("recently_viewed", doomed.client
      .rpc("shelf_track_game_view", { p_game_id: gameId }));
    const { data: post, error: postError } = await doomed.client.from("posts")
      .insert({ author_id: doomed.userId, body: "post from an account about to be deleted" })
      .select().single();
    if (postError || !post) throw new Error(`seeding posts: ${postError?.message}`);

    // Both directions across the follow graph. The reverse one is the interesting
    // case: it is a row the OTHER account owns, pointing at this one, and an RPC
    // deleting table-by-table under RLS would never have seen it.
    await seed("follows (outgoing)", doomed.client.from("follows")
      .insert({ follower_id: doomed.userId, followee_id: other.userId }));
    await seed("follows (incoming)", other.client.from("follows")
      .insert({ follower_id: other.userId, followee_id: doomed.userId }));

    // A like by the other account generates a notification owned by the doomed one.
    await seed("post_likes", other.client.from("post_likes")
      .insert({ post_id: post.id, user_id: other.userId }));

    // A real 1x1 PNG, not a few arbitrary bytes. The bucket restricts uploads to
    // image/jpeg, image/png and image/webp, so a text/plain placeholder is rejected --
    // and a rejected upload makes every storage assertion below pass vacuously, which
    // is the exact shape of false green this script exists to avoid.
    const onePixelPng = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (ch) => ch.charCodeAt(0));

    const objectPath = `${doomed.userId}/verify-delete.png`;
    const { error: uploadError } = await admin.storage.from(BUCKET)
      .upload(objectPath, onePixelPng, { contentType: "image/png" });
    check("seeded a stored image", !uploadError, uploadError?.message);
    if (uploadError) throw new Error("cannot test storage cleanup without a stored object");

    const { count: notifBefore } = await admin.from("notifications")
      .select("*", { count: "exact", head: true }).eq("user_id", doomed.userId);
    check("the account has a notification to lose", (notifBefore ?? 0) > 0, `${notifBefore}`);

    // ---- 2. The guard ----
    console.log("\n2. The confirmation guard");

    const token = await tokenFor(doomed);

    const missing = await callDelete(token, {});
    check("a body without confirm is refused", missing.status === 400, `${missing.status}`);

    const wrong = await callDelete(token, { confirm: "yes" });
    check("the wrong confirm string is refused", wrong.status === 400, `${wrong.status}`);

    const stillThere = await admin.from("profiles")
      .select("user_id").eq("user_id", doomed.userId).maybeSingle();
    check("a refused call deletes nothing", stillThere.data !== null);

    const noAuth = await fetch(`${FUNCTIONS}/account-delete`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "delete" }),
    });
    check("an unauthenticated call is refused", noAuth.status === 401, `${noAuth.status}`);

    const wrongMethod = await fetch(`${FUNCTIONS}/account-delete`, {
      method: "GET", headers: { Authorization: `Bearer ${token}` },
    });
    check("GET is refused", wrongMethod.status === 405, `${wrongMethod.status}`);

    // ---- 3. The delete itself ----
    console.log("\n3. Deleting");

    const done = await callDelete(token, { confirm: "delete" });
    check("the delete returns 200", done.status === 200, `${done.status} ${JSON.stringify(done.body)}`);
    check("it reports deleted", done.body?.deleted === true);
    check("it reports the images it removed", done.body?.imagesRemoved === 1,
      `${done.body?.imagesRemoved}`);
    doomedGone = done.status === 200;

    // ---- 4. Is it actually gone? (service role, on purpose) ----
    console.log("\n4. What is left behind");

    const { data: authUser } = await admin.auth.admin.getUserById(doomed.userId);
    check("the auth user is gone", !authUser?.user, authUser?.user?.id);

    const tables = [
      "profiles", "library_entries", "wishlist_entries", "posts",
      "notifications", "share_intake", "platform_accounts", "content_reports",
      "recently_viewed",
    ] as const;
    for (const table of tables) {
      const column = table === "posts" ? "author_id"
        : table === "content_reports" ? "reporter_id"
        : "user_id";
      const { count } = await admin.from(table)
        .select("*", { count: "exact", head: true }).eq(column, doomed.userId);
      check(`${table} has no rows left`, count === 0, `${count}`);
    }

    // The rows the OTHER account owns that pointed at this one.
    const { count: theirFollow } = await admin.from("follows")
      .select("*", { count: "exact", head: true }).eq("followee_id", doomed.userId);
    check("somebody else's follow OF this account is gone too", theirFollow === 0,
      `${theirFollow}`);

    const { count: theirLike } = await admin.from("post_likes")
      .select("*", { count: "exact", head: true }).eq("user_id", other.userId);
    check("their like is gone with the post it was on", theirLike === 0, `${theirLike}`);

    // Storage, which is the part no cascade reaches.
    const { data: leftover } = await admin.storage.from(BUCKET).list(doomed.userId);
    check("the storage folder is empty", (leftover?.length ?? 0) === 0,
      `${leftover?.length} objects`);

    // A public bucket serves objects by URL with no auth, so this is the check that
    // the privacy promise actually holds rather than just the database one.
    const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(objectPath);
    const fetched = await fetch(pub.publicUrl);
    check("the image is no longer fetchable by its public URL", !fetched.ok,
      `${fetched.status}`);

    // ---- 5. The survivor ----
    console.log("\n5. The other account is untouched");

    const { data: survivor } = await admin.from("profiles")
      .select("user_id, handle").eq("user_id", other.userId).maybeSingle();
    check("the other account still exists", survivor?.user_id === other.userId);

    const stale = await callDelete(token, { confirm: "delete" });
    check("the orphaned token no longer authenticates", stale.status === 401,
      `${stale.status}`);

  } finally {
    await removeAccounts(doomedGone ? [other] : [doomed, other]);
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
