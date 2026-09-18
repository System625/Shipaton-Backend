# Onboarding steps 4 & 5: what the backend gives you

**For:** Sola
**From:** Tunde
**Date:** 18 September 2026 — shipped and verified live the same day

This is the whole answer to your 16 Sep note, built against `Prysm - Onboarding.pdf`
rather than just the note — the PDF changes the shape of item 2 (see below), and it's
the design you'll be checking screens against, so worth reading this with it open.
Nothing else in the backend changed to make this work; you don't need any other doc
to wire these two screens.

Both calls need a signed-in user (same as everything else you call today) and return
plain JSON rows, keys in `snake_case` — not `CatalogGame`'s `camelCase`.

---

## Step 4, "Where do you play on?" — one column, your existing `.update()`

```ts
await supabase.from('profiles').update({ platforms: ['pc', 'mobile'] })
  .eq('user_id', userId)
```

The exact five values, same as `/search`'s `device` param: `playstation`, `xbox`,
`nintendo`, `pc`, `mobile`. No new endpoint and no policy change — the own-profile
UPDATE policy is row-level with no column list, and the table-level grant on
`profiles` covers a column added after the grant was made. Your existing call, run
today, just starts writing it.

- **A skip writes nothing, and that's correct.** The column defaults to `'{}'`, not
  null — "chose nothing" and "hasn't been asked yet" are the same state on purpose.
- **`{platforms: ['switch']}` (or any value outside the five) is a Postgres `23514`,
  surfaced to you as HTTP 400** — not a validation error you'd get a friendlier
  message for. Check the five values client-side too if you want a nicer error.
- **One gotcha in a short window right after this shipped, not something you'll hit
  now:** PostgREST caches the schema, so a write to a brand-new column can 404 with
  `PGRST204` for a few seconds after a migration lands. It resolved itself; flagging
  it so a stale report of it doesn't get misread as a policy bug.
- **Device icons on other people's rows (design p6) read from this same column**,
  returned on the suggested-accounts row below. It's empty for everyone until they
  complete step 4, and empty forever for anyone who skips it — render nothing rather
  than inventing a fallback. (`library_entries.platform_id` — what people play a game
  on — was the other candidate; it's populated on seeded/imported accounts only and
  is 0 for every real account today, so it would read as a bug on real installs.)

---

## Step 5, "Meet players like you" — `shelf_suggested_users`, not the 7-column row

```ts
const { data } = await supabase.rpc('shelf_suggested_users', { max_results: 20 })
```

**Eleven columns, not seven.** Your note asked for the same row as
`shelf_search_users`; the design renders `18 games · 12 hrs`, device icons and
`4 games in common` per row, which that row can't carry. So: the first seven columns
are byte-identical to `shelf_search_users` / `shelf_followers` / `shelf_following`
(`user_id, handle, display_name, avatar_color, bio, followed_by_me, is_me` —
`followed_by_me` and `is_me` are always `false` here, since already-followed accounts
and yourself are both excluded from the list), and four more are appended after them:

```jsonc
{ /* …the usual seven… */
  "games_in_common": 4,
  "library_count": 18,
  "hours_played": 12.5,   // or null — see below
  "platforms": ["pc", "playstation"]
}
```

This is a deliberate widening of the shelf-privacy line: `library_entries` is
owner-only everywhere else, and this function (SECURITY DEFINER) publishes aggregates
over it to any signed-in caller. Decided on purpose because the design can't render
without them — no titles, no per-game detail, never anyone's own rows to anyone else,
just four counts.

- **`hours_played` is `null`, not `0`, on every real account today.** All 391
  `hours_played` rows in the current database belong to the 28 seeded demo profiles;
  every real signup has it null across their whole library. Render null as absent —
  don't show "0 hrs" for someone who simply hasn't logged hours yet, that's a
  different claim.
- **Ranking, so you know what you're looking at, not so you rebuild it client-side:**
  games-in-common first, then shared platforms, then library size, then hours, with
  one floor — accounts with fewer than 3 games sort last (never excluded, so the list
  can't come back empty from this alone). This matters at onboarding specifically
  because a step-5 viewer's library is only the 3 games they just picked in step 3
  (or nothing, if they skipped it), so games-in-common maxes out very low and the
  floor is what stops a 1-game match from outranking a real shelf.
- **Excludes people already followed and both directions of a block**, same rule as
  everywhere else with a follow list.
- **A viewer who skipped step 3 and/or step 4 still gets a full list** — it just
  can't rank on games-in-common or shared platforms for them, and falls through to
  library size.

---

## Still open, and worth your answer

- **The empty-list floor.** Step 5 isn't skippable and needs the CTA to activate at
  "x follows" — your call, not decided here. Today the candidate pool for a brand-new
  account is 32 (of which 28 are the seeded demo population, see below), so it's not
  urgent, but a fresh install base could hit a genuinely empty list on day one for the
  very first few users. Recommend: let the client allow finishing with zero follows
  when the list actually comes back empty, not merely unused.
- **What's `x` in "the CTA gets active when at least x-number of people are
  followed"?** Yours to set; changes nothing server-side either way.
- **Where did the 28 seeded demo accounts come from?** (`tunde_backlog`,
  `zainab_quests` and the rest — 10–28 games each, hours filled, `created_at`
  backdated to 4–5 Sep.) There's no seed script for them in this repo, so they were
  made outside it. If they're staying, they're part of every new user's first five
  minutes on this screen and should be acknowledged somewhere; if they're test data,
  they need a removal path before launch.

---

## Why it's built this way (for whoever touches this next, not required reading for Sola)

**Your note asked for a 7-column row; the design won.** `task.md` specified the same
row as `shelf_search_users` so the client could reuse `ProfileSummary` unchanged. The
Figma PDF renders `18 games · 12 hrs`, device icons and `4 games in common` per row —
counts your note's shape can't carry. Built against the PDF, since that's the actual
screen. `ProfileSummary` still works: the first seven columns are unchanged, the four
new ones are appended, not inserted.

**Returning those four counts is a deliberate widening of the shelf-privacy line.**
Everywhere else, `library_entries` is owner-only — nobody else can see what's in your
library. This function (SECURITY DEFINER) publishes aggregates over it to any
signed-in caller: games-in-common, library size, hours, platforms. Decided rather than
defaulted to, because the alternative doesn't just ship a smaller version of this
screen — it ships a different one, since the design can't render without those
numbers. The leak is bounded on purpose: aggregates only, never a title, never a
per-game detail, never anyone's own rows shown to someone who isn't them.

**The thin-shelf tier exists because of a number we actually measured, not a hunch.**
Games-in-common leads the ranking, which is right by the design's own stated intent —
but at onboarding the viewer's library is only the 3 games they just picked in step 3
(or nothing, if they skipped it). Measured against the live database: the maximum
games-in-common for a fresh 3-game account, across every other profile, was **1**. So
that lead term is nearly constant exactly when it's supposed to matter most, which
revives the original worry a different way — a 1-game account sharing that one game
would outrank a real 28-game shelf. Fix: accounts with fewer than 3 games sort last,
whatever they share, but are never excluded, so the list can't come back empty.

**The migrations themselves carry this same reasoning as SQL comments** —
`supabase/migrations/20260918100000_profile_platforms.sql` and
`supabase/migrations/20260918100100_suggested_users.sql` — so it stays next to the
code it explains rather than only living here.
