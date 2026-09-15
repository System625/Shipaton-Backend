// POST /account-delete {"confirm":"delete"} -> { deleted: true }
//
// Apple guideline 5.1.1(v) requires an in-app way to delete the account before an
// app with sign-in can pass review. Fine to ship TestFlight without it, not fine to
// submit without it -- which is what makes this a release gate rather than a feature.
//
// WHY THIS IS AN EDGE FUNCTION AND NOT AN RPC. Sola asked for "the same shape as
// shelf_disconnect_platform, just wider", and that was the natural guess, but it
// cannot work: the thing being deleted is the `auth.users` row, and no function
// running as the caller can touch the auth schema. Only the service role can, and
// the service role key is available here and nowhere the client can reach.
//
// It is also far less code than the RPC would have been. Every one of the seventeen
// foreign keys from public tables to auth.users is ON DELETE CASCADE -- checked
// against the live database, not read off the migrations:
//
//   content_reports.reporter_id   follows.follower_id     follows.followee_id
//   library_entries.user_id       notifications.user_id   notifications.actor_id
//   platform_accounts.user_id     platform_link_nonces.user_id
//   post_comments.author_id       post_likes.user_id      posts.author_id
//   profiles.user_id              recently_viewed.user_id share_intake.user_id
//   user_blocks.blocker_id        user_blocks.blocked_id  wishlist_entries.user_id
//
// `recently_viewed` joined the list on 15 Sep (20260915140000). It is the one table
// here whose contents the user never chose to create -- a browsing history is
// recorded FOR them -- which makes it the one most worth being certain the delete
// reaches. It does, by the same cascade as the rest.
//
// So deleting the one row clears all seventeen tables, including the rows OTHER people
// own that point at this user: their follows of you, their notifications about you,
// their blocks of you. An RPC deleting table by table would have had to find those
// too, and RLS would have hidden most of them from it.
//
// STORAGE IS THE EXCEPTION, and it is the whole reason this function has a body.
// `storage.objects` has no foreign key to auth.users, so the cascade does not reach
// it. `post-images` is a PUBLIC bucket, so an orphaned object stays fetchable by URL
// forever, by anyone, after the account that uploaded it is gone. That is exactly the
// thing account deletion is supposed to prevent, so it is cleared first and a failure
// to clear it aborts the whole delete.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";

// Post images live at `<user id>/<whatever>`, and the storage RLS policy refuses any
// upload whose first path segment is not the uploader's id. That prefix is what makes
// a user's objects findable here without a join back to `posts`.
const BUCKET = "post-images";

// storage.list() pages. Its own default is 100; asking for more costs nothing and
// means one round trip for every account that has not posted hundreds of images.
const PAGE = 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  // An explicit confirmation in the body, because this is the one endpoint with no
  // undo. It is not security -- the caller already proved who they are -- it is a
  // guard against a mis-wired screen or a retried request deleting somebody's
  // account. The app should still put a typed confirmation in front of it.
  let confirm: unknown;
  try {
    ({ confirm } = await req.json());
  } catch {
    return errorResponse('expected JSON body {"confirm":"delete"}', 400);
  }
  if (confirm !== "delete") {
    return errorResponse('expected {"confirm":"delete"} to proceed', 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- 1. Storage, before the user row ----
  //
  // ORDER MATTERS AND IS NOT ARBITRARY. Both orderings can fail halfway; they fail
  // differently. Delete the user first and a storage failure leaves public images
  // with no owner, no account to retry from and nothing left in the database
  // pointing at them -- unrecoverable without a manual sweep. Clear storage first
  // and a failure leaves the images gone but the account intact, which the user can
  // simply retry. The recoverable failure is the one to choose.
  const paths: string[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data: objects, error } = await admin
      .storage
      .from(BUCKET)
      .list(auth.userId, { limit: PAGE, offset });

    if (error) return errorResponse(`could not list stored images: ${error.message}`, 500);
    if (!objects || objects.length === 0) break;

    // `list` returns names relative to the prefix, and remove() wants full paths.
    for (const o of objects) paths.push(`${auth.userId}/${o.name}`);
    if (objects.length < PAGE) break;
  }

  if (paths.length > 0) {
    const { error } = await admin.storage.from(BUCKET).remove(paths);
    // Abort rather than carry on. See the note at the top: an orphaned object in a
    // public bucket outlives the account, which defeats the point of the endpoint.
    if (error) return errorResponse(`could not delete stored images: ${error.message}`, 500);
  }

  // ---- 2. The user row, and sixteen cascades ----
  //
  // Hard delete: `shouldSoftDelete` defaults to false, which is what is wanted here.
  // A soft delete would keep the row, and every cascade above would therefore not
  // fire -- the account would look deleted and none of the data would be gone.
  const { error: deleteError } = await admin.auth.admin.deleteUser(auth.userId);
  if (deleteError) return errorResponse(deleteError.message, 500);

  // The caller's token is now orphaned. It stays cryptographically valid until it
  // expires, but every request it makes resolves to a user that no longer exists, so
  // the app must sign out locally on a 200 rather than waiting for a 401.
  return json({ deleted: true, imagesRemoved: paths.length });
});
