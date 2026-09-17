# Shelf backend: notes for Sola

**For:** Sola
**From:** Tunde
**Date:** 11 September 2026

This replaces every earlier version of this file. Anything from the 4, 7 and 8 September
notes that still matters is repeated below; everything else was stale and is gone.

I read the app at `akintewe/revenue-cat-game` through commit `cfa0909` (10 Sep, "Sync
library with the real backend"). The library sync is exactly right: PostgREST, scoped by
RLS, optimistic writes with rollback, and `/games/popular` replacing the 15-query
workaround. It unblocks more than it looks like it does, and section 3 covers what.

Every status code and payload below was captured from the live project today, not
written from the source.

**Base URL for edge functions:** `https://sbunhrxwhraigwpidbxk.supabase.co/functions/v1`
**Full reference:** `docs/openapi.yaml` in the backend repo, and the Shelf API Reference
page. The wishlist isn't in either yet, so section 2 of this file is its reference for
now.

---

## 1. Where everything stands

Everything on the backend is live and verified. What's left is app wiring.

| Feature | How the app calls it | In the app at `cfa0909` |
|---|---|---|
| Search | `GET /search?q=` | Wired |
| One game | `GET /games/<uuid>` | Wired |
| Popular | `GET /games/popular?limit=&offset=` | Wired |
| Library | PostgREST: `library_entries` | Wired, 10 Sep |
| **Wishlist ("Saved")** | **PostgREST: `wishlist_entries`** | **New today, not wired. Section 2** |
| Roulette | `GET /roulette?platform=&hours=&size=` | No screen yet. Section 3 |
| Popular with friends | `GET /games/popular-with-friends` | Not wired. Section 3 |
| **Recently viewed** | **`GET /games/recently-viewed`** | **New today, not wired. Section 11** |
| Friends feed | PostgREST tables + `shelf_feed`, `shelf_profile_stats` | `FRIEND_POSTS` mock. Section 4 |
| Notification inbox | `shelf_notifications` and two more RPCs | Bell has no `onPress`. Section 4 |
| Share a link | `POST /share-resolve`, `POST /share-confirm` | Not wired, no `expo-share-intent` yet. Section 5 |
| **Finish card** | **Nothing — no endpoint, no migration** | **Blocked on three columns missing from your select. Section 7** |
| **Vague search** | **`POST` / `GET /vague-search`** | **Built 16 Sep, not deployed yet. Nothing to wire until it is — read section 12 now so the screen can be designed ahead of it** |

Two conventions that hold everywhere:

- **Edge functions return camelCase `CatalogGame`.** PostgREST tables return the row
  **as stored, in snake_case** (`game_id`, `added_at`). You already handle this in
  `remoteLibrary.ts`.
- **Every call needs a signed-in user.** Functions 401 without a token; tables return
  nothing to a signed-out client.

---

## 2. New today: the wishlist is on the server

"Explore Saved" and the Wishlist tab still read `useWishlistStore`, which is
AsyncStorage only. So saved games are lost on reinstall, never reach a second device,
and are **shared by every account that signs in on the same phone**. That last one is a
real bug now that accounts exist. There is now a table for it, and it works exactly
like the library: no edge function, `supabase.from()` directly, owner-only by RLS.

### Why a separate table and not a fifth library status

- `fetchLibraryEntries()` reads every `library_entries` row with no status filter, and
  `GameStatus` has four values. A `'wishlist'` row would land in the Library as a status
  your screens can't render.
- The Library counts rows against `FREE_TIER_GAME_LIMIT`. Saving a game you don't own
  would use up the free tier.
- Your UI lets a game be saved *and* in the library at once. A status can't be both.

### The table

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | **Defaults to the signed-in user.** Leave it out of inserts |
| `game_id` | uuid | Catalog id. Must be a uuid, not a slug |
| `reminder_enabled` | boolean | Defaults to `true` |
| `added_at` | timestamptz | Set by the server |

`(user_id, game_id)` is the key, so a game can only be saved once per account. Deleting
an account deletes its wishlist.

### A `remoteWishlist.ts` to sit next to `remoteLibrary.ts`

```ts
const WISHLIST_COLUMNS = 'game_id, reminder_enabled, added_at';

export async function fetchWishlistEntries() {
  const { data, error } = await supabase
    .from('wishlist_entries')
    .select(WISHLIST_COLUMNS)
    .order('added_at', { ascending: false });
  if (error) throw error;
  return data;
}

export async function insertWishlistEntry(gameId: string) {
  const { data, error } = await supabase
    .from('wishlist_entries')
    .insert({ game_id: gameId })          // user_id is filled in server-side
    .select(WISHLIST_COLUMNS)
    .single();
  if (error) throw error;
  return data;
}

export async function setWishlistReminder(gameId: string, enabled: boolean) {
  const { error } = await supabase
    .from('wishlist_entries')
    .update({ reminder_enabled: enabled })
    .eq('game_id', gameId);
  if (error) throw error;
}

export async function deleteWishlistEntry(gameId: string) {
  const { error } = await supabase.from('wishlist_entries').delete().eq('game_id', gameId);
  if (error) throw error;
}
```

RLS already scopes updates and deletes to the caller's own rows, so `.eq('game_id', …)`
alone is safe. Adding `.eq('user_id', userId)` like `remoteLibrary.ts` does is harmless
too.

### What comes back

Insert:

```json
{
  "user_id": "ba900ed2-932f-4347-b543-b51de306d542",
  "game_id": "6e42b13e-b183-4337-af6b-a033c01f84cf",
  "reminder_enabled": true,
  "added_at": "2026-09-11T21:27:34.814887+00:00"
}
```

You can pull the release date in the same request by embedding the game:

```ts
supabase.from('wishlist_entries')
  .select('game_id, reminder_enabled, added_at, games(title, release_date, cover_url)')
```

```json
[
  {
    "game_id": "df5583ab-0832-463e-878a-8626b76e1d68",
    "reminder_enabled": true,
    "added_at": "2026-09-11T21:27:35.116349+00:00",
    "games": {
      "title": "Kirby Air Riders",
      "cover_url": "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/coaauz.jpg",
      "release_date": "2025-11-20"
    }
  }
]
```

Errors, all real:

| When | `code` | `message` |
|---|---|---|
| Saving a game twice | `23505` | duplicate key value violates unique constraint "wishlist_entries_pkey" |
| `game_id` not in the catalog | `23503` | … violates foreign key constraint "wishlist_entries_game_id_fkey" |
| `game_id` is a slug like `'elden-ring'` | `22P02` | invalid input syntax for type uuid: "elden-ring" |
| Writing someone else's `user_id` | `42501` | new row violates row-level security policy for table "wishlist_entries" |

Delete returns `204` with no body.

### Four things to get right when you wire it

1. **The two seed entries are slugs.** `DEFAULT_ENTRIES` holds `'kirby-air-riders'`
   and `'hollow-knight-silksong'`, which the table rejects with `22P02`. Both games are
   in the catalog, so if you want to keep them:

   | Slug | Catalog id |
   |---|---|
   | `kirby-air-riders` | `df5583ab-0832-463e-878a-8626b76e1d68` |
   | `hollow-knight-silksong` | `6e42b13e-b183-4337-af6b-a033c01f84cf` |

   Dropping them like you did for the library seed is simpler, though. Both games came
   out in 2025, so they'll never show a release reminder in a demo anyway. Pick
   something with a future `releaseDate` for that.

2. **Release reminders never arm for real games right now.** `syncReminder()` looks the
   release date up with `findCatalogGame()`, which only knows the local demo catalog, so
   for any uuid it finds nothing and quietly does nothing. Take the date from the backend
   instead: the embedded `games.release_date` above, or the resolved `CatalogGame`'s
   `releaseDate`. The check should be `releaseDate > today`. The backend sends a date
   for every game that has one, past or future, so the field being present doesn't mean
   the game is unreleased.

3. **Don't render covers from the embed.** The embedded `games(...)` is the raw row: it
   has `cover_url`, not `coverImageUrl`, and **no `abbreviation` or `colorKey`**. Those
   two are computed in the edge functions, not stored. `GameCover.tsx` turns a missing
   `colorKey` into slate grey without an error. Keep rendering through
   `useResolvedGames` as you do now, and use the embed only for the reminder date.

4. **Make it per-account, like the library.** Hydrate on sign-in, `reset()` on sign-out,
   and stop persisting to AsyncStorage. `reminder_enabled` is stored on the server so a
   reinstall or a second device knows which local reminders to schedule again. The
   reminder itself is still your `expo-notifications` one.

One product call that's yours: **adding a saved game to the library leaves it saved.**
The backend allows both at once. If "Add to library" should also remove it from the
wishlist, that's one extra `deleteWishlistEntry()` call in the app.

---

## 3. What your library sync just unlocked

Until 10 Sep the app wrote nothing to `library_entries`, so the two features below
returned empty for every real account. That's no longer true, and both are one screen
away.

### Roulette

```
GET /roulette?platform=167&hours=1.5&size=quick   ->  CatalogGame | null
```

- **`platform` is required.** It's the integer platform id from `CatalogGame.platforms[].id`
  (PS5 is `167`, PC is `6`). If it's missing, you get a `400`.
- **`hours`** is how long they have tonight. It changes the odds but never filters.
  A 30-minute session against a backlog of 60-hour RPGs still returns something.
  Defaults to 2.
- **`size`** is optional: `quick`, `medium` or `epic`. Anything else is a `400`.
- **`null` means one thing only: nothing in their backlog is on that platform.** It
  never means "your filters excluded everything".
- It picks from `backlog` and `playing` entries.
- **Never cache it.** The same request returns a different game on purpose, since it's
  a weighted random pick. Any response cache, React Query `staleTime`, or memoising on
  the URL makes it look like the roulette is broken.

### Popular with friends

```
GET /games/popular-with-friends?limit=20&offset=0   ->  (CatalogGame & { friendCount })[]
```

This ranks games by how many of the people you follow have them as `playing` or
`beaten`. It counts only followees who have `profiles.share_activity` switched on. That
defaults to `true`, **so the app needs a settings toggle**, or "opt-in" is only a word.
It never says *which* friend has a game, only how many. That's deliberate: libraries
stay private.

---

## 4. Friends feed and notifications: built, waiting on the app

The Friends tab is still `FRIEND_POSTS` in `LibraryScreen.tsx`. The backend for all of
it has existed since 9 Sep. Payloads are in the API reference; the short version:

**First, write a `profiles` row on first sign-in.** Nothing in the app does this yet, and
**without it the feed and the notification inbox both render empty**:

| Field | Rule |
|---|---|
| `user_id` | the signed-in user's id |
| `handle` | lowercase, `^[a-z0-9_]{3,20}$`, unique. Taken = `23505` |
| `display_name` | 1–40 characters |
| `avatar_color` | one of your ten `coverColors` keys. Defaults to `slate` |
| `bio` | optional, up to 160 |

**It's follow, not friendship.** A follows B needs nothing from B, which matches the
follower/following counts your UI already shows.

- **Posts:** insert into `posts` with `author_id`, `body`, and optionally `link_url`,
  `game_id` and `image_path`. Images go in the `post-images` storage bucket, and **the
  path must start with the user's id** (`<user id>/whatever.jpg`), or the upload is
  refused.
- **Reading the feed:** `rpc('shelf_feed', { p_limit, p_before, p_before_id, p_handle })`.
  Pagination uses a cursor: pass the last row's `created_at` and `id` for the next page.
  Leave out `p_handle` for the feed, and pass one for a profile's posts.
- **Profile header counts:** `rpc('shelf_profile_stats', { p_handle })`.
- **Likes and comments:** `post_likes` and `post_comments`. Liking twice (or following
  twice) is rejected with `23505`, never counted twice, so treat that code as "already
  done".
  A post's author can delete comments on their post.
- **Blocks and reports:** `user_blocks` and `content_reports`. App Store review
  (guideline 1.2) requires both before user-generated content ships, so they need a
  place in the UI, even a small one.
- **The inbox:** `rpc('shelf_notifications', { p_limit, p_before, p_before_id, p_unread_only })`,
  `rpc('shelf_unread_notification_count')` for the badge, and
  `rpc('shelf_mark_notifications_read', { p_ids })` (leave out `p_ids` to mark all
  read). It covers follows, likes and comments. It's **in-app only, no push**. Push can
  be added later without changing any of this.

Libraries and share history stay private to their owner. Nothing in the feed shows what
someone has in their library.

---

## 5. Sharing a link, still to wire

Two calls, both `POST`, both JSON, both need the user's token. The paths use a hyphen:
`share-resolve`, not `share/resolve`.

```
POST /share-resolve   { "url": "<whatever the share sheet gave you>" }
  -> { intakeId, provider, extractedText, confident, candidates[] }

POST /share-confirm   { "intakeId": "<from above>", "gameId": "<the one they tapped>" }
  -> the library_entries row, snake_case
```

- **`/share-resolve` always returns 200 and never writes to the library.** `candidates: []`
  means we couldn't tell, so show a search box. The link is saved either way.
- **`confident: true` means show one big result. It never means skip the confirm step.**
- **`extractedText`** is the caption or title we read. Showing it ("we read this from
  your link") makes a wrong guess make sense.
- **`/share-confirm` adds the game as `backlog` with the source link.** Re-confirming a
  game they already have returns their existing row untouched, so a beaten game stays
  beaten.

Measured on 21 real gaming TikTok links: 16 came back confident, and 14 of those
were the right game. That's why the confirm step stays.

**App-side setup, so it doesn't catch you out late:**

- It needs `expo-share-intent`, which means a dev build (`expo prebuild`, then
  `expo run:ios` / `run:android`). Expo Go can't receive shares.
- On SDK 57, `expo prebuild` **wipes and regenerates** `ios/` and `android/` by default.
  Use `--no-clean` if you have native changes in there.
- On iOS the share extension hands the URL to the app through an App Group. If the
  App Group isn't configured for both targets, shares fail **silently**: the sheet
  shows the app, you tap it, and nothing arrives. Check this first if iOS shares seem
  to do nothing.

---

## 6. Contract details that still hold

- **Search got better on 12 Sep and the contract did not change.** Two kinds of query
  that used to return the wrong game now work: the name with the spaces taken out
  (`awayout`, `battlefield6`, `dragonsdogma2` — all now first, none was even in the top
  5 before), and a query whose every word is accounted for by one game (`zelda botw`
  now returns Breath of the Wild). Same response shape, same `score` thresholds, and 21
  queries were captured before and after so the ones that already worked still do.
  Nothing on your side needs touching — your search screen just gets fewer wrong
  answers.
- **`colorKey`** is always one of your ten `theme.ts` keys (`teal, orange, purple, pink,
  gold, navy, red, green, blue, slate`). If you rename or drop one, tell me, because my
  checks can't see your theme file.
- **Fields that can be missing:** `releaseDate`, `coverImageUrl`, `timeToBeatHours`
  (only ~5% of games have it), `sessionFit`, `criticScore`, `slug`. `pcRequirements`
  is always missing for real games, because IGDB has no such data.
- **Cover art is 3:4, 528 × 704.** This corrects my 4 Sep note, which said 528 × 748
  from IGDB's docs. I measured the actual files this week and 98.4% of covers are 3:4.
  **No source we have serves square art**, IGDB or Steam — the only near-miss was
  Steam's transparent wordmark, which reaches ~46% of rated games and misses every
  Nintendo and PlayStation exclusive, so it was not shippable. **Closed 12 Sep:** Paul
  dropped the two-ratio ask and settled on one, and it's yours app-side now. **One
  thing to nail down before you build to it** — his ratio came to me relayed as
  "4:3", which is *landscape*. What IGDB actually serves is **3:4 portrait**. Those
  are different shapes; please confirm which he means.
- **`criticScore` is IGDB's critic aggregate, not Metacritic.** Don't label it that.
- **IGDB attribution is required** by their terms: visible, in a fixed place, can be
  small.
- **Search for vague descriptions** ("feudal Japan, guy with a metal arm, really hard")
  is a **separate endpoint**, not a change to `/search`'s contract — see section 12.

---

## 7. The finish card — the backend owes nothing, you need three columns

The design landed on **the app rendering and capturing the card itself**, with a plain
Shelf link riding along in the share text. So there is **no endpoint, no migration and
no image renderer coming** — please don't wait on me for any of it. (The alternative
was a public URL that unfurls in a paste, which is the better growth loop but needs a
capability token, a Deno renderer, cover-art caching and a decision from Josh about
publishing a private row. Against the 30 Sep deadline it wasn't worth it. If it ever
comes back, that's the shape.)

**What blocks it is three lines in your repo.** `src/services/library/remoteLibrary.ts:19`:

```ts
const LIBRARY_COLUMNS = 'game_id, status, rating, notes, hours_played, added_at';
```

`source_url`, `source_kind` and `finished_at` are not in there, `LibraryRow` has no
fields for them, `rowToEntry()` doesn't map them, and `LibraryEntry`
(`src/features/library/types/index.ts`) has no fields for them either. The odd part is
that `LibraryPatch` in the same file **already writes `finished_at`** — `useLibraryStore.ts:107`
sets it the moment a game goes `beaten`. So the app writes that timestamp and can never
read it back, and the link the share flow worked hard to capture never comes home.

All three columns have been on the table since the first migration and RLS is
row-level, so **they are already readable by you — nothing server-side has to change.**
Add them to the select, the row type and the entry type and the card has its data.

**The gotcha worth knowing before you design the card.** `source_url` is only ever
written by `/share-confirm`. Your own `insertLibraryEntry` hardcodes
`source_kind: 'search'` and no URL (`remoteLibrary.ts:44`), so **a game the user found
by searching has no "found on" line at all.** The card's best headline — "found on
TikTok in March, beaten in September" — only fires for shared games. Worth designing
the no-source variant deliberately rather than discovering it on a real account.

**Nothing can be demoed yet, and that's not a bug.** On 12 Sep `library_entries` held
exactly **one row in the whole database** — my own verification row — and `beaten` was
zero. Nobody has finished a game yet. Seed yourself a couple of `beaten` rows with a
rating and a `finished_at` to build against.

---

## 8. What I still need from you

1. ~~**The package name and bundle ID.**~~ **CLOSED 15 Sep, and not the way this was
   hoping.** Both stores are now locked to `com.nathanakin.revenuecatgame` — iOS by the
   App Store Connect record (TestFlight build 13 is live under it), Android because the
   Play Console app was created under the same name before this was raised. There is no
   remaining window without abandoning both app records and starting over, so nothing
   left to do here: Josh is setting up RevenueCat and Firebase/FCM against this name with
   no risk of rework.
2. ~~**The app's name.**~~ **SETTLED 14 Sep — it is Prysm.** The store listings, the
   `prysm://` scheme and the bundle id all key off this. The backend repo and these
   docs still say "Shelf" throughout; that is an internal name for the service and is
   not worth a rename mid-build, but nothing user-facing should carry it.
3. ~~**Confirm the deep link scheme.**~~ **CONFIRMED 14 Sep — `prysm://` is final**,
   now that the name is. It is already set as the Steam callback's return URL. The
   redirect allow-list on the auth project is **still empty**, so Google and Apple
   sign-in cannot return to the app — that is now the only thing left here, and it is
   mine to do once you confirm the exact redirect paths the app registers.
4. **Sign-in providers.** Email/password is on, and it's what you're using. Google and
   Apple are still off, waiting on Josh's accounts. One decision for the sign-in screen:
   **use one provider per platform, Apple on iOS and Google on Android.** Apple's Hide My
   Email gives a relay address that never matches someone's Google email, so a person
   who uses both gets two separate accounts. Their library looks like it vanished, and
   there's no error to debug.

---

## 9. New today: Steam import, and the four things it needs from the app

Connecting a Steam account and pulling the user's library is built and deployed.
It is the single best onboarding moment we have — a typical account goes from an
empty shelf to several hundred games in about two seconds — so it is worth wiring
carefully.

### The flow is three calls plus a browser trip

```
  app                     backend                        Steam
   |  POST /steam-link-start  ->|
   |<- { redirectUrl, nonce }   |
   |-- open redirectUrl in a browser ------------------->|  user signs in
   |                            |<- GET /steam-link-callback?nonce&openid.*
   |<- 302 <scheme>://link/steam?status=ok&nonce=...     |
   |  POST /steam-link-finish { nonce } ->|
   |<- PlatformAccount          |
   |  POST /steam-import ->|
   |<- { total, matched, inserted, updated, unmatched }  |
```

`status` on the redirect is `ok`, `failed` or `expired`. Only on `ok` should the app
call `/steam-link-finish`. The nonce is single-use and dies after ten minutes.

**This is a connection, never a sign-in.** Do not put "Sign in with Steam" on the
auth screen. The moment Steam becomes a way to *create* an account, App Store
guideline 4.8 pulls Sign in with Apple into scope for the whole app. As a connection
inside an already-signed-in session it costs us nothing. Valve also requires one of
their supplied "Sign in through Steam" button images on the button itself — grab it
from `partner.steamgames.com`, don't draw your own.

### 1. The deep link scheme — settled, and already wired

**The app is called Prysm.** Settled 14 Sep, so `prysm://` is final rather than
provisional, and `APP_LINK_RETURN_URL` is set to **`prysm://link/steam`** in Supabase
secrets. The callback 302s to:

```
prysm://link/steam?status=ok|failed|expired&nonce=<the nonce>
```

The app needs to handle that route. If you would rather have an `https://` universal
link, say so and it is a one-command change — but the scheme works and nothing is
blocked on it now.

Two consequences worth acting on, since the name is no longer in flux: the auth
redirect allow-list can finally be populated (section 8 item 3's other caller —
Google and Apple sign-in still cannot return to the app without it), and the package
name / bundle ID in section 8 item 1 can be settled in the same pass. That one goes
permanent at the first Play Store upload.

### 2. `source_kind` has three new values

`library_entries.source_kind` was `'tiktok' | 'youtube' | 'search' | 'manual'`. It is
now also `'steam' | 'xbox' | 'psn'`. If the app types that as a closed union or
switches on it to pick an icon, **imported rows will fall through** — the same shape
of problem as `colorKey`, where neither side reported the mismatch. `'psn'` is in the
constraint even though PlayStation is not built, so tolerate it now and never think
about it again.

There is also a new nullable `imported_uid` column. Ignore it; it exists so a
disconnect knows what it created.

### 3. Show both numbers, and the paywall goes AFTER them

`/steam-import` returns `total` and `matched`, and they always differ. **How much
they differ depends entirely on what kind of Steam user it is, and you should design
for the bad case.**

Measured 14 Sep against a real 4,652-game account:

| | resolved |
|---|---|
| everything they own | **38.6%** |
| everything they have ever played | **83.1%** |
| their top 20 by playtime | **85.0%** |

**Owned and played are different sets, and the miss is concentrated entirely in the
never-opened part.** That account has played 148 of 4,652 games; the rest is bundle
and giveaway shovelware (`Iggle Pop! Deluxe`, `Typer Shark! Deluxe`), which our
catalog deliberately does not carry. Blender, Wallpaper Engine and Source Filmmaker
are in there too, and dropping those is correct — they are not games.

So *"Added 412 of your 468 Steam games"* is right for a normal account, but a
collector will see *"Added 1,797 of your 4,652"* and think we are broken. Two things
help:

- **Lead with what they play.** If you sort or headline by `hours_played`, the top
  of the list is ~85% complete regardless of library size, and it is the part they
  recognise.
- **Say why, in one line.** "The rest are mostly bundle extras and non-game apps we
  don't track" turns a number that looks like failure into one that looks like a
  filter. Don't just say *"Done"* — that invites them to go hunting.

**And the paywall lands after this screen, never before it** — Josh's call on 14 Sep,
with the conversion evidence in `docs/research/pricing.md` §4. Imported rows *do*
count against `FREE_TIER_GAME_LIMIT` (50), and the backend deliberately does not
enforce that on the import path. Run the import, show them all 412 games we found,
*then* ask. Being asked to pay for a number you cannot see yet is a much worse
moment.

### 4. The private-profile error is the one you must design for

This will be our top support complaint, and Steam makes it silent: if the user's
**Game details** privacy is not Public, Steam returns HTTP 200 with an empty body and
no error at all. `/steam-import` detects it and answers `409` with:

```json
{
  "error": "steam_profile_private",
  "message": "Your Steam game details are private, so Steam returns an empty library. Set Game details to Public and try again.",
  "fixUrl": "https://steamcommunity.com/my/edit/settings"
}
```

Render `fixUrl` as a button, not as text. A generic "import failed" here sends the
user looking for a bug on our side.

### Disconnecting

`rpc('shelf_disconnect_platform', { p_platform: 'steam' })`. It deletes the
connection and every imported row the user never touched, and returns how many it
removed. **Games they made their own are kept** — anything they re-statused, rated or
annotated stays in the library and just stops claiming to come from Steam. Apple
5.1.1 already requires in-app account deletion; this is the same idea one level down,
and it is two hours of UI that keeps us clean with both store reviews.

### What is not coming

**Last-played dates and per-device playtime do not exist.** The research doc claimed
Steam returns them; it does not, for a third-party key reading someone else's
profile — measured across a real 4,652-game library on 14 Sep, zero rows carried any
of them. Total hours per game is all we get. If a screen was designed around "last
played on Deck", it needs redesigning.

**Xbox is import-only** and PlayStation is not built. Neither is in this release.

## 10. New today: the search screen's filter header

Paul's search doc (pages 3–5) puts three controls above the results: the **Release
Date** pill, the **Categories** pill (genre + device type) and the **Sort By**
portal. All three are now `/search` query parameters. Full reference is in
`openapi.yaml`; this is what you need to know to wire it.

**Everything is applied in the query, before the 10-row limit.** Do not filter the
response — `/search` returns 10 rows, so filtering those in the app gives a
near-empty list on a screen that looks like it should be full.

```
GET /search?q=eden
  &releaseFrom=2020-01-01&releaseTo=2029-12-31   // the pill
  &genre=rpg&genre=puzzle                        // OR'd; comma form also works
  &device=xbox&device=pc                         // OR'd
  &sort=recent&sortDir=desc
```

**The app owns the Release Date bucket labels and their boundaries.** The backend
takes two ISO dates and nothing else. Paul's "2020s / 2020-2026" label is already
dated and he will move it again; if the eras lived in the API, every move would be
a migration. "Upcoming" is `releaseFrom` = tomorrow, `releaseTo` omitted.

**"Upcoming" means dated future releases only — settled 14 Sep.** 3,668 games
carry a future date and those are what you get. A game announced with no date at
all is not in the catalog (2 such rows in 89,123, and IGDB's undated games are
excluded from both seed passes on purpose), so the pill cannot mean
"announced, whenever". Paul owns rewording the label if "sometime in future"
oversells it; nothing changes on this side.

**The backend owns the genre vocabulary**, which is the opposite call and
deliberate: the rollups are facts about IGDB's data, not UI choices. You send pill
slugs. `strategy` quietly covers `Turn-based strategy (TBS)`, `Real Time Strategy
(RTS)`, `Tactical` and `MOBA` — there is no way you could know that from the app.

**Four of Paul's 14 genre pills have no IGDB data and are not going to get any** —
`action`, `souls`, `open-world` and `survival` return `200 []`. IGDB has no
"Action" genre at all (it files those under Shooter, Fighting, Hack and slash and
Arcade), and the other three are themes/keywords — columns that exist but are
empty for all 89,123 rows. Decided 14 Sep not to re-seed for them: a pill the
provider has no data for doesn't get invented in the backend, so this is yours to
reconcile in the app.

**Read the vocabulary, don't hardcode it.** `genre_pills` is a real table and you
can select from it with a normal authenticated session:

```ts
const { data } = await supabase.from("genre_pills").select("pill, genre");
// distinct `pill` = every slug that actually filters something
```

Build the pill row from that and an unservable pill can never ship again — when
the mapping changes, the app follows without a release. The ten that work today:
`adventure`, `rpg`, `fps`, `strategy`, `simulation`, `sports`, `racing`,
`fighting`, `platformer`, `puzzle`.

**If you and Paul want to re-cut the pills against what IGDB actually has**, this
is the whole vocabulary — all 23 genre names in the catalog, with the number of
games carrying each:

| genre | games | | genre | games |
|---|---|---|---|---|
| Indie | 50,948 | | Point-and-click | 2,427 |
| Adventure | 34,288 | | Card & Board Game | 2,032 |
| Simulator | 19,208 | | Fighting | 1,771 |
| Strategy | 16,416 | | Hack and slash/Beat 'em up | 1,682 |
| Role-playing (RPG) | 15,520 | | Turn-based strategy (TBS) | 1,646 |
| Puzzle | 11,095 | | Tactical | 1,344 |
| Arcade | 7,841 | | Music | 941 |
| Shooter | 6,667 | | Real Time Strategy (RTS) | 884 |
| Platform | 6,538 | | Quiz/Trivia | 448 |
| Visual Novel | 4,973 | | MOBA | 93 |
| Sport | 4,056 | | Pinball | 92 |
| Racing | 3,791 | | | |

Note what Paul's sheet has no pill for and probably wants one: **Indie** is the
single largest genre in the catalog at 50,948 games. **Visual Novel** (4,973) and
**Card & Board Game** (2,032) are also unrepresented. Adding any of these is a
two-row insert on my side — say the word and they work the same day.

**`device` has exactly five values** — `playstation`, `xbox`, `nintendo`, `pc`,
`mobile`. Anything else is a 400. Note that 4,094 catalog rows (retro, arcade, VR,
browser, Stadia) match none of the five and vanish under any device filter; that
is correct, not a bug to report.

**`sort=rating` is thin and you should know before you build the row.**
`criticScore` is on 8,952 of 89,123 games — 10%. The other 90% sort on absence,
not merit. It is honest for scored games and close to arbitrary below that.

**`sort=recent` hides unreleased games unless you ask for them.** 3,668 catalog
rows carry a future date and would otherwise fill the entire first page ahead of
everything that has shipped. If you set any release window — including Upcoming —
the window is respected exactly and nothing is capped.

**`sort=best_match` is the default and is byte-identical to today's behaviour.**
An unfiltered, unsorted `/search?q=` call returns exactly what it returned before.

---

## 11. New today: recently viewed, and a bigger catalog

Two things landed on 15 Sep. The first is the last backend item from your punch
list; the second changes what `/search` finds, with no app work at all.

### Recently viewed — one new route, and you do not write to it

```
GET /functions/v1/games/recently-viewed?limit=20&offset=0
```

Returns **the same `CatalogGame` objects as `/search` and `/games/popular`**, newest
first, plus one extra field:

```jsonc
[
  {
    "id": "…", "title": "Hades II", "platforms": [...], "coverImageUrl": "…",
    "abbreviation": "H2", "colorKey": "purple",   // …the usual CatalogGame
    "viewedAt": "2026-09-15T14:02:11.318Z"        // …and this
  }
]
```

So the rail renders through the component you already have. `viewedAt` is additive,
exactly like `friendCount` on popular-with-friends.

**You do not record views. I do.** Opening `GET /games/<uuid>` *is* the view — the
server writes the history row on the way out. There is nothing to call, nothing to
batch, nothing to remember on a cold start, and no way for what the app shows and
what the server recorded to drift apart. That drift is the bug that has bitten this
project three times now (colorKey, the wishlist, the library).

**The one thing I need you to do: pass `?track=0` when you fetch a game and nobody is
looking at it.** Re-hydrating a library list, prefetching the next card, warming a
cache — anything that is not a person opening a detail screen:

```ts
const game = await api(`/games/${id}?track=0`);   // does not touch the history
```

Get this wrong and the rail slowly fills with games nobody opened. From your side
that looks like a backend bug, and it is unfixable from mine, because the server
cannot tell a prefetch from a person.

Three more properties worth knowing:

- **Re-opening a game moves it to the top, it does not add a second row.** No
  de-duplication needed in the app.
- **It is capped at 50 per user**, oldest dropped. Ask for more than 50 and you get
  50.
- **It is private, and it stays private.** Owner-only, never in the feed, never
  aggregated into popular-with-friends, not counted against the 50-game free tier.
  Browsing history is more revealing than a library — it includes everything someone
  looked at and did not add — so it sits on the strict side of the line the social
  graph drew, not the library's side. Account deletion takes it with everything else.

### The catalog now holds re-releases

The seed used to admit only "main games", which quietly excluded every remake,
remaster, port and expanded edition. Concretely: our `Resident Evil 2` was the
**1998 original**, `Resident Evil 4` was **2005**, `Mario Kart 8` was the **Wii U**
one, and `Persona 5 Royal`, `The Last of Us Part I` and `Dark Souls: Remastered` were
absent entirely. ~2,043 rows are being added.

**Nothing changes on your side, but one thing will look different, and it needs a UI
decision from you.** Some searches now return several rows with the *same title*. This
is intended — they are genuinely different games — but it is sharper than "two rows":

| title | rows in the catalog | span |
|---|---:|---|
| `Resident Evil` | **5** | 1996 → 2024 |
| `Resident Evil 4` | 4 | 2005 → 2023 |
| `GoldenEye 007` | 3 | 1997 → 2023 |
| `Resident Evil 2` | 2 | 1998 → 2019 |

510 titles collide this way. **Where it bites hardest is the share confirm screen.**
Measured on 15 Sep against the 21 real TikTok links: one of them now offers four
candidates all reading exactly `Resident Evil`, which is an unpickable list if the row
shows only a title. The ranking still puts the most popular one first and the overall
hit rate did not move (19/21 confident, unchanged), so the *default* is right — the
problem is only visible when the user goes to choose.

**Everything you need to tell them apart is already in the payload and always was.**
Every candidate is a full `CatalogGame`: `releaseDate`, `coverImageUrl`, `platforms`.
Showing the year next to the title on the confirm screen and in search results is
enough. Nothing is needed from me for this.

---

## 12. New (16 Sep): vague search — "the game I saw two days ago"

Josh's ask: search by a half-remembered description — *"Feudal Japan, guy with a
metal arm, really hard"* → **Sekiro: Shadows Die Twice**. It works, measured against
77 real posts pulled from r/tipofmyjoystick (not queries any of us wrote): **0% → 42.3%
of the time it's the very first result, 49.3% it's in the top 5**, up from a plain
keyword search of the catalog, which answers essentially none of these. Full
measurement in `docs/research/semantic-search.md` if you want the numbers behind the
numbers.

**Not deployed yet — this section is so you can design the screen before it lands,
not something to wire this week.** The code is built and committed. What's left is
non-code: pushing three migrations, deploying two functions, and Josh topping up the
DeepSeek balance that powers it (in progress, expected soon). I'll tell you the day
it's live; until then treat everything below as the contract it will land with.

### Why this can't be "type a sentence, get a result" the way `/search` is

The model call this depends on is slow, and not a little slow: measured over 71 real
queries, **median 25.7 seconds, p90 68.8 seconds, worst case 227.5 seconds**. That's
not a spinner, and it's long enough that our own server infrastructure can't hold a
single request open for it either. So this is **submit, then poll** — closer to how
you'd handle a video upload finishing processing than to how `/search` works.

### The two calls

```
POST /vague-search
  { "query": "feudal japan, guy with a metal arm, really hard" }
```

Two possible responses, both the same shape:

**Someone already asked something close to this recently** (cache hit — happens
instantly, no wait):

```jsonc
{
  "id": "5b0e...",
  "status": "done",
  "query": "feudal japan, guy with a metal arm, really hard",
  "candidates": [ /* full CatalogGame objects, best guess first */ ],
  "confidence": null,          // not carried on a cache hit, see below
  "fromCache": true,
  "error": null,
  "createdAt": "2026-09-16T20:04:11.000Z",
  "completedAt": "2026-09-16T20:04:11.000Z"
}
```

**Nobody's asked this before** (the common case) — you get a `202` and an empty
result, and now you poll:

```jsonc
// 202
{
  "id": "5b0e...",
  "status": "pending",
  "query": "...",
  "candidates": [],
  "confidence": null,
  "fromCache": false,
  "error": null,
  "createdAt": "2026-09-16T20:04:11.000Z",
  "completedAt": null
}
```

```
GET /vague-search?job=5b0e...
```

Same shape, `status` becomes `"done"` (candidates filled in, `confidence` is a real
0–1 number this time) or `"error"` (`error` is a human-readable string, `candidates`
stays `[]`) once it's ready. Poll this until `status` is no longer `pending` or
`processing`.

### How to poll, given the latency numbers above

- **Don't poll faster than every 3-4 seconds** — the median answer takes 25 seconds,
  so a 1-second poll is ~25 wasted round trips per search for no benefit.
- **Don't give up early.** The worst case measured is 227.5 seconds — just under 4
  minutes. If the screen stops polling at 30 or 60 seconds because "that's how long a
  network request should take", it will report a false failure on the very queries
  this feature exists for (the ones with an unusual, hard-to-place description).
  Recommend: keep polling for at least 5 minutes before telling the user to give up.
- **Design for "still thinking" as the default state, not the exception.** A spinner
  labelled "found it!" seconds after submit is going to be wrong most of the time.
  Something like "this can take a couple of minutes" set at submit time will read as
  honest instead of broken.
- **A push notification will eventually cover the "close the app and wait" case** —
  once OneSignal's credentials exist (still Josh's, see the push section elsewhere in
  this doc), the server sends one titled "Found your game" the moment a job
  completes. Nothing to build for that beyond what push already needs; it's a nice-to
  -have on top of polling, not a replacement for it, since polling is what covers
  someone waiting on the actual screen.

### Reading the result once it's `done`

- **`candidates` can be an empty array even on `status: "done"`.** That's not a bug —
  it means either the model genuinely didn't recognise the description, or it named
  something that isn't in our catalog. Design an explicit "couldn't find it, try
  rephrasing or search normally" state; don't treat `[]` as still-loading.
- **`confidence` is returned as the model gives it, 0–1, and is *not* thresholded on
  our side.** 0.98 on Sekiro means "this is almost certainly it"; something around
  0.5-0.6 means the model is guessing between a few plausible answers. **What to do
  with a low number — hide results below some cutoff, or show them with a
  "possibly…" label — is a product call for Paul, not decided yet.** Worth raising
  with him before this screen is designed rather than picking a threshold
  independently; I'll pass along whatever he decides.
- **Every candidate is a full `CatalogGame`**, same as everywhere else in this API —
  render it through the same component you already use for search results and the
  share-confirm screen.
- **`fromCache: true` means someone else asked something normalised to the same
  question recently** (case/punctuation-insensitive, not a semantic match — a
  differently-worded question about the same game is a fresh job, not a cache hit).
  Not something to surface in the UI, just an explanation for why some answers come
  back instantly and most don't.

### One thing worth knowing so it doesn't read as a bug report

The model is asked to always name its best guess rather than say "I don't know" — on
the 71-query measurement it produced a title for all 71, right or wrong. Combined with
every title being checked against the real catalog before it's ever shown (so a
completely made-up title can never appear), a *wrong* answer still comes back as a
real, existing game — never gibberish, never a 404. That's deliberate and it's why
the confidence number matters more here than it would somewhere the model can simply
decline to answer.

---

## 13. New (17 Sep): Seasonal Challenges, and a catalog date-precision fix

Session A of the Events screen build. `research/events-screen.md` measured that the
"Release-Day Tracker" you and Paul leaned toward is the cheapest schema and the most
expensive *data* — the catalog's upcoming release dates are mostly placeholders, and
Seasonal Challenge's data (library completions + genres) was already sitting there,
unused. Decided internally by Josh, not routed to Paul as a product call. Release-Day
is Session B, once this data fix has landed — building it before this would mean
building it twice.

### Seasonal Challenge Tracker — live

```
rpc('shelf_challenges')
```

Every challenge, with your progress against it:

```jsonc
[
  {
    "id": "…",
    "title": "Beat 3 RPGs This Month",
    "description": "Finish three Role-playing games between 1 and 31 October to complete this challenge.",
    "startDate": "2026-10-01",
    "endDate": "2026-10-31",
    "criteria": { "genres": ["Role-playing (RPG)"], "count": 3 },
    "status": "upcoming",              // "active" | "upcoming" | "ended", computed server-side
    "myProgress": { "count": 0, "target": 3 }
  }
]
```

(Field names above are camelCase as the app will see them through supabase-js; the
column names in Postgres are snake_case, same as everywhere else.)

- **Team-authored only.** No creation UI, no admin endpoint — a challenge is a row,
  written by `scripts/seed-challenges.ts` on our side. That answers "who authors a
  challenge" for season one without committing to anything about season two.
- **Returns every challenge, active/upcoming/ended alike** — same choice as
  `shelf_recently_viewed`: the RPC hands you the full shape, the screen decides what
  to render. Your note showed "a list of active/upcoming challenges" — filter on
  `status` client-side.
- **`myProgress.count`** only counts a game if it's `beaten` AND finished inside
  `[startDate, endDate]` AND its genres overlap `criteria.genres`. One real bug this
  closed: 2 library rows had a `finishedAt` set while their status was NOT `beaten` —
  a live disagreement the research doc measured. A new database trigger keeps the two
  in sync from now on: moving a game to `beaten` sets `finishedAt` if it isn't already
  set, and moving it *off* `beaten` clears it. If your app has any code that reads
  `finishedAt` independent of `status`, it can now trust that pairing.
- **`criteria.genres` is IGDB's genre strings** (`"Role-playing (RPG)"`, `"Shooter"`,
  not display labels) — match `games.genres` exactly if you ever render criteria
  yourself. **`Indie` matches 56% of the catalog (51,512 of 91,806 games)** — worth
  knowing before anyone reaches for it as a challenge filter.
- **"October Horror Challenge" (your other worked example) doesn't fit this shape
  yet.** IGDB files "Horror" under *themes*, not *genres* — `games.themes`, a
  different column, which `shelf_challenges()` doesn't currently match against.
  Season one shipped with the RPG example, which is a genre. Say the word if a
  theme-based challenge is wanted and I'll widen the criteria shape.
- **No join/participant mechanic.** Your note marked `participant_count` optional
  ("only if challenges are joinable") — not built, since nothing asked for it yet.

### Catalog fix: `release_date` now carries a precision

Corrects a claim in `research/events-screen.md` itself: it said the seed already
fetched the field this depends on and just wasn't using it. Checked against live
IGDB before building — that field (`release_dates.category` in older docs and in
that draft) doesn't exist on the current API; the real one is `release_dates.date_format`,
and it was not being fetched anywhere in this repo until today.

Every `CatalogGame`'s `release_date` now sits next to `releasePrecision`:
`"day" | "month" | "quarter" | "year" | null`. `null` means either genuinely unknown
(`releaseTbd: true`) or the rare unmatched row (21 of them, listed in the backfill
log). **Only trust a release date as day-accurate if `releasePrecision === "day"`.**

Measured on the live catalog after the backfill:
- Whole catalog (91,781 dated games): 86,194 day, 1,439 quarter, 1,007 month, 3,141
  year.
- **Just the upcoming 3,748: 83.5% are NOT day-precise** (617 day, 876 quarter, 159
  month, 2,086 year, 10 unresolved) — confirms the research doc's original 80.4%
  estimate, now against real IGDB precision data instead of inferred from date
  patterns like "31 Dec".
- This is exactly why Release-Day (Session B) waited on this fix: a day-of
  notification built on the old data would have been wrong four times in five.
- **Not yet wired into the "Upcoming" search filter or the on-device release
  reminders** (`src/services/notifications/reminders.ts`) — both still read the raw
  `release_date` with no precision check. That's the next place this should land;
  raising it here so it doesn't get lost as "already fixed" when it's only half fixed.
