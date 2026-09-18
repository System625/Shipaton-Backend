# The long-press quick-view card: what the backend gives you

**For:** Sola
**From:** Tunde
**Date:** 18 September 2026 — shipped and verified live the same night

This is the whole answer to Paul's quick-view mock and to `task.md`'s question about
a background sitting behind the cover — both shipped together, so this is one file
rather than two. You don't need `docs/research/quick-view-card.md` to build against
this; that doc is the internal record of the measurements and the options we didn't
take. Everything you need to actually call is below.

Both calls need a signed-in user (same as everything else you call today).

---

## 1. The description — `summary` on every `CatalogGame`

Every `CatalogGame` now carries `summary`: IGDB's own description text, returned
**raw, untruncated**. It reaches you everywhere a `CatalogGame` does — `/search`,
`/games/:id`, `/games/popular`, `/games/popular-with-friends`,
`/games/recently-viewed`, `/games/watching`, `/roulette`, and the candidates array
inside `/share-resolve` and `/vague-search`. Absent (not empty string) on the 2.8%
of the catalog IGDB has no summary for.

```jsonc
{
  // …the usual CatalogGame fields…
  "summary": "Grand Theft Auto V is a vast open world game set in Los Santos…"
}
```

**Three things you own, not us:**

1. **Truncate it yourself.** It's a full paragraph — median 233 characters, up to
   9,844 on the longest row. We deliberately did not clamp it server-side. A
   model-written short blurb (~$5 to generate one per game) was costed and declined,
   and a derived short column was rejected too — neither fixes the two real
   problems (see point 3), and both put risk on the table a raw paragraph doesn't.
2. **Collapse whitespace before you clamp.** 30.6% of summaries contain a literal
   newline. Clamp-to-two-lines on the raw string spends one of those two lines on a
   blank for nearly a third of games. Collapse `\s+` to a single space first.
3. **`1998.` is not a bug.** Half-Life 2's summary genuinely opens with a dateline —
   IGDB's text, not ours to fix. If a QA report calls this out, it's expected. Two
   other shapes to expect and not file as bugs: ~40% of summaries open by repeating
   the game's own title (redundant under the title you already render), and
   whatever cut point your clamp lands on will sometimes fall mid-sentence — that's
   the trade-off of a real paragraph over an invented one-liner, made on purpose.

No ellipsis is added server-side either — add one on truncation if the design wants
it.

---

## 2. The background art — `game-artwork`, answering `task.md` directly

`task.md` asked for something behind the cover art — video/GIF was researched and
ruled out entirely (YouTube's terms forbid an overlay on top of an embedded player,
and IGDB has no usable video, not even via its `animated` flag, which is metadata
that doesn't survive the CDN). A **still image** is what's actually deliverable, and
it's live.

**You don't strictly need this.** The app already blurs the cover behind the game
detail screen, which is free, needs no call, and covers 100% of the catalog. Treat
`game-artwork` as the upgrade path if the design wants real key art instead of a
blurred cover — call it, and fall back to the blur (what you already do) on an empty
result or an error.

```
POST /functions/v1/game-artwork
Authorization: Bearer <user JWT>
Content-Type: application/json

{ "gameIds": ["<uuid>", "<uuid>", …] }   // 50 ids max per call
```

Response — one entry per id you sent, for every id that actually exists:

```jsonc
{
  "artwork": {
    "82f3c221-34c2-427d-8d02-881c82737926": "https://images.igdb.com/igdb/image/upload/t_screenshot_huge/sc1a2b.jpg",
    "5dcd1a8c-51fd-49ab-aaa8-de9ef5eb8191": ""   // IGDB has nothing for this one — render your existing blur, not a broken image
  }
}
```

**How it resolves an image**, in order: the game's first screenshot, then its first
artwork if it has no screenshot, then an empty string if IGDB has neither. Empty
string is a real, cached answer — a second call for the same id won't re-ask IGDB,
it'll just tell you again there's nothing. Size is `t_screenshot_huge`: a fixed
1280×720 centre-crop, 16:9, measured at ~126 KB. Call it once per game and cache the
URL yourself; it fills `games.artwork_url` server-side on first call, so a repeat
call for the same id is instant and free (no IGDB round trip) rather than merely
cheap.

**Three things to know before you wire it:**

1. **Batch your calls.** 50 ids per request, and a batch of previously-unfetched ids
   costs real IGDB round trips (rate-limited to 4/sec on our side) — call it once
   per screen's worth of games, not once per card as it scrolls into view.
2. **An empty string is not an error — a 5xx is.** Treat `""` as "no art, use your
   blur" and a non-2xx response the same way, rather than surfacing either as broken
   UI.
3. **This endpoint is shared, uncapped infrastructure — call it deliberately, not
   speculatively.** It spends the project's single shared IGDB API quota with no
   per-caller limit of its own. Fine for "the games on screen right now"; wrong for
   prefetching every game in a long scrollback just in case.

---

## Still open, and worth your answer

- **Whether the quick-view card should call `game-artwork` at all, or ship with just
  the blurred cover.** Both are live and either is a valid choice — the blur is
  free and already there; real art is one call away if the design wants it. Not
  decided here on purpose.
- **The whitespace collapse and the truncation cut point (§1)** are yours — nothing
  server-side assumes a specific line count or character limit.
- **The ellipsis**, if you want one on a truncated summary — also yours.

---

## Why it's built this way (for whoever touches this next, not required reading for Sola)

**The description ships raw because every alternative either lies or costs money we
don't have to spend on invented text.** A first-sentence truncation renders `1998.`
for Half-Life 2 and a mid-sentence cut for half the popular catalog — tested against
the 15 most-rated games in the catalog before this was decided. A model-written
one-liner (~$5 for the rated slice via a batched Haiku call) would fix both, but
puts text on screen that reads as ours under a real game's cover, which is a product
risk, not an engineering one, and was declined on that basis rather than cost.

**The background art already existed when this card was built — this doc is what
finally writes down the contract for it.** `game-artwork` and the `artwork_url`
column it fills were built in an earlier session answering the same `task.md` ask
this quick-view work also answers, but the app-facing contract for it had never been
written up before now. Full detail, including exactly how it resolves an image and
what it costs per call, is in `docs/research/quick-view-card.md` §3e if you ever need
more than the contract above.
