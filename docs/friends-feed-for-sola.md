# Friends feed — what's new, for Sola

**Written 18 September 2026.** This is the only place the feed's client contract
lives — `technical-notes-for-sola.md` §4 now just points here.

**Status: live.** Pushed and deployed 18 Sep, `npm run verify:feed` passes (30
checks), and the existing `verify:social` / `verify:notifications` suites still
pass untouched. The Supabase security and performance advisors show nothing new.
Safe to build against everything below now.

**First, the correction from your note (`task.md`):** most of what it asked for was
already live, and your app is already using it — `posts.category`, polls (create,
vote, close), reposts, shares and the "X reposted" card all work server-side today,
under different names than the note used in a couple of places (see the table
below). The research behind all of that is `docs/research/friends-feed.md`, if you
want the full evidence trail. This doc only covers what was actually missing.

---

## 1. What's actually new in this pass

1. **Repost notifications.** Reposting has been silent — 24 reposts happened live
   before this and notified nobody. Fixed: a repost now rings the bell and pushes,
   the same as a like or a comment.
2. **`posts.visibility`** — a `public` / `friends` toggle on every post.
   **`friends` means mutual follow**: visible to accounts the author follows *and*
   who follow the author back. Not one-way followers — a stranger can't put
   themselves in that audience just by following you.
3. **`shelf_post(p_post_id)`** — fetch one post by id, directly. Replaces the
   `findPostById` page-scan in `NotificationsScreen.tsx`, which was reading up to
   200 fully-joined feed rows to find one post, and only ever worked for your own
   posts.
4. **Mention notifications.** `@handle` in a post body now notifies that person,
   capped at 10 mentions per post. You already parse and link `@handle`
   client-side (`RichText.tsx`) — this only adds the bell/push side.

## 2. The feed row: 29 columns → 30

`shelf_feed` and the new `shelf_post` return the identical shape. One new column,
`visibility`, inserted after `category`:

```
id, body, link_url, image_path, created_at, edited_at, author_id, handle,
display_name, avatar_color, category, visibility, game_id, game_title, game_cover,
game_artwork, game_year, game_genres, game_rating, game_platforms, poll,
like_count, comment_count, repost_count, share_count, liked_by_me,
reposted_by_me, reposted_by_handle, reposted_by_name, reason
```

`visibility` is `'public'` or `'friends'`. Every existing row, and every post your
app writes today, defaults to `'public'` — nothing changes for you until you start
passing the new parameter below.

## 3. Creating a post with an audience

`shelf_create_post` gains one more argument, appended last and defaulted, so your
existing 7-key call keeps working exactly as it does today:

```ts
rpc('shelf_create_post', {
  p_body, p_category, p_game_id, p_image_path, p_link_url,
  p_poll_options, p_poll_hours,
  p_visibility: 'public' | 'friends',   // new, defaults to 'public'
})
```

There's no UI for this at your app's HEAD — the old "Public ⌄" pill in the design
never got built. When you're ready, this is: an audience selector in the composer,
`visibility` typed on `FeedPost`, and optionally a "Friends only" badge on
`PostCard.tsx` for an author's own restricted posts. None of that blocks the
backend or anything else on your list.

One behavioural note worth knowing before you build the selector: once a post is
`friends`, anyone outside that audience is refused at insert (`42501`), not
silently ignored, if they try to repost, share or comment on it via its id — so a
stray deep link to a friends-only post's id fails loudly rather than doing
something that looks like it worked.

## 4. Fetching one post by id

```ts
rpc('shelf_post', { p_post_id })
```

Returns the same 30-column row as a `shelf_feed` entry — an array with 0 or 1
rows, not a scalar. Empty means either the post doesn't exist or you can't see it
(deleted, or a friends-only post outside your audience) — same as a feed row just
not being there, no separate error to handle. `reposted_by_handle` and
`reposted_by_name` are always null here (there's no ranking context for a single
lookup), and `reason` is `'self'` / `'following'` / `'popular'` — cosmetic, you
don't currently read it.

Use it to replace `findPostById`'s scan in `NotificationsScreen.tsx`: every
notification row now carries `post_id`, so a tap becomes one call instead of up to
four pages of `shelf_feed`. It also means a repost or mention notification can
finally open its post — `findPostById` only ever worked for your own.

## 5. Repost notifications

Nothing new to write — you already insert into `post_reposts` for the repost
itself. The `post_repost` kind now appears in `shelf_notifications` /
`shelf_unread_notification_count`, with `post_id` set, same shape as `post_like`.
It pushes too, like every other kind.

**Your `NotificationKind` union is missing two kinds already, independent of this
pass** — `game_release` (live since 17 Sep, 0 rows so far, so you haven't hit it
yet) and now `post_repost`. Both currently fall through `describe()` to `''` and
`iconFor()` to `undefined`, rendering as a name with no text and no icon.
`shelf_notifications` also already returns `game_id`, `game_title` and
`game_cover_url`, which `ShelfNotification` doesn't type. Add both kinds, type the
three game columns, and route a tap: `game_release` opens the game, `post_repost`
and `post_mention` open the post via `shelf_post` (§4).

## 6. Mention notifications

A `post_mention` kind, same shape as `post_repost` — `post_id` set, no
`comment_id`, no `game_id`. Fires on post create and on any edit that changes the
body, capped at the first 10 `@handle` matches per post, skips self-mentions and
blocked accounts, and won't re-notify the same person twice for the same post
(editing the text and keeping the same mention doesn't double-fire).

## 7. What `task.md` got right that needs no change from you

Category, polls (create/vote/close), reposts, shares, and the "X reposted" card in
the feed are already fully built and your app is already using them — the note's
"suggested order" was solving problems that no longer existed. The one place the
note's names differ from what shipped: it's `post_polls` / `post_poll_options` /
`post_poll_votes` (not `polls`/`poll_options`/`poll_votes`), and a vote **can** be
moved, not locked after the first cast — your `moveVote()` already relies on that.

## 8. Loose end, not blocking you

`psn-import` is called by your app (`EXPO_PUBLIC_PSN_IMPORT`) but isn't deployed —
returns a real 404 live. It's already off in your config, so nothing is broken
today; noting it so it isn't a surprise later. PlayStation linking is separately on
the roadmap.
