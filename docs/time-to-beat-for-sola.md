# Time to beat: show the submission count — and what else is waiting for you

Written 18 September 2026. Self-contained: you should not need to open another doc
to build the feature in §1. §3 onwards is the shorter list of things that are live
on the backend and still unwired in the app.

Companion to `docs/quick-view-card-for-sola.md` (the `summary` description and
`game-artwork` background). Same pattern — one file per feature, so you are not
scrolling `technical-notes-for-sola.md` looking for the bit that changed.

---

## 1. The feature: never show hours without the count beside them

**Paul's decision, 18 Sep:** wherever the app shows a time to beat, show how many
people that time came from. Brackets are fine when space is tight:

```
12 hrs (2)
```

### Why this is not cosmetic

Of the 4,954 games in the catalog that have a time at all, **2,929 — 59.1% — have it
from a single person's submission.** 84% rest on three or fewer. The app currently
renders those as a bare "12 hrs", which presents one stranger's playthrough as a fact
about the game.

We considered hiding the unreliable ones instead, and rejected it on the numbers:

| Rule | Games that would still show a time |
|---|---|
| Show everything (today) | 4,954 (100%) |
| Hide below 3 submissions | 1,181 (24%) |
| Hide below 5 | 555 (11%) |
| Hide below 10 | 177 (4%) |

Any cutoff strict enough to mean something deletes the feature from three quarters of
the games that have it. So we show everything and let the count carry the caveat.

### The field

`CatalogGame` gained `timeToBeatCount`, sitting next to `timeToBeatHours`:

```ts
timeToBeatHours?: number;   // e.g. 120.4
timeToBeatCount?: number;   // e.g. 25  <- new
```

**It is live now** on every endpoint that returns a `CatalogGame`: `/search`,
`/games/:id`, `/games/popular`, `/roulette` and `/vague-search`. Verified against the
deployed functions with a real signed token, not locally:

```
/search        Elden Ring     120.4h (25)
/games/popular GTA V          127.5h (70)
/vague-search  Hitman         15.7h (5)
```

### Rules for rendering it

1. **Absent means absent, not zero.** Both fields are optional and they travel
   together: if `timeToBeatHours` is missing, `timeToBeatCount` is missing too. Show
   nothing at all — do not render "0 hrs" or "(0)".
2. **Never show hours without the count.** That is the whole decision. If your layout
   genuinely cannot fit it somewhere, tell us rather than dropping it silently.
3. **The count is submissions, not players and not hours.** If the label needs to be
   explicit somewhere roomier than a card, "from 2 submissions" is accurate.
4. **`timeToBeatHours` is a decimal.** 120.4, not 120. Round for display as you see
   fit; the server does not round for you.

### Where it needs to appear

Anywhere the hours already appear — game detail, the quick-view card, search rows,
roulette. If you are already reading `timeToBeatHours` in a component, that component
needs the count.

---

## 2. Vague search is live, and it changes your screen design

This was built on 16 September but nothing scheduled it, so a request sat unanswered
forever. **That was fixed today and the whole path now runs unattended.** Proof, from
a job created and finished with no human involved:

```
11:05:37  pending
11:06:17  done   -> Hitman, Hitman 2, Hitman 3, Blood Money, Absolution
                    confidence 0.80
query: "the one where you play a bald assassin with a barcode tattooed on the back of his head"
```

### It is two calls, not one, and this is not negotiable

Naming a game from a vague description takes a **median of 25.7 seconds**, p90 68.8s,
and a measured **maximum of 227.5s**. That last number is longer than an edge function
is permitted to run at all, so the endpoint cannot answer synchronously. It creates a
job and you poll it.

```
POST /functions/v1/vague-search      { "query": "..." }   -> 202 + job (usually pending)
GET  /functions/v1/vague-search?job=<uuid>                -> the job
```

Both need the user's JWT. Minimum query length is 4 characters.

The job body:

```jsonc
{
  "id": "71507edd-…",
  "status": "pending" | "processing" | "done" | "error",
  "query": "the one where you play a bald assassin…",
  "candidates": [ /* full CatalogGame objects, already hydrated */ ],
  "confidence": 0.8,          // null until done
  "fromCache": false,
  "error": null,
  "createdAt": "2026-09-18T11:05:37Z",
  "completedAt": "2026-09-18T11:06:17Z"
}
```

`candidates` are complete `CatalogGame` rows — cover art, summary, `timeToBeatHours`,
`timeToBeatCount`, `releasePrecision`, all of it. No second fetch to render results.

### What the screen has to survive

- **Poll every 3–4s, and keep going for at least 5 minutes.** The median alone is 25
  seconds. A spinner that gives up at 10s will fail on most queries.
- **"Still thinking" is the normal state, not an edge case.** Design that state
  properly; it is what the user looks at for half a minute.
- **A repeat query returns instantly with `fromCache: true`.** Same shape, no wait.
- **`candidates` can be empty** on `status: "done"`. That is "we found nothing",
  not an error.
- **`status: "error"`** carries a message in `error`.

### The one thing still undecided — and it is Paul's, not yours

`confidence` is returned exactly as the model gave it, unthresholded. **The model
never says "I don't know"** — it returned a title for all 71 queries in our
evaluation, so roughly half of its answers are confidently wrong, and because we
ground every title against the real catalog, a wrong answer is still a real game,
which makes it *more* plausible rather than less.

So either the UI thresholds on `confidence` and shows a "not sure" state below some
line, or it always presents candidates as options rather than a verdict. **Not
decided.** Build the list-of-options shape for now; it is safe under either outcome.
The Hitman result above is a good illustration: 0.80 confidence and five sequels, no
single right answer.

---

## 3. Smaller things that are live and still unwired

Nothing here needs backend work. All of it is app-side.

### 3a. The finish card needs three more columns in your select

`source_url`, `source_kind` and `finished_at` are not in the app's `library_entries`
select, and `LibraryEntry` (`src/features/library/types/index.ts`) has no fields for
them. RLS is row-level so they are already readable — nothing server-side changes.

The card's whole headline ("found on TikTok in March, beaten in September") cannot be
rendered until those three columns join that string and three fields join that type.
The app already *writes* `finished_at` and never reads it back.

**The gotcha:** `source_url` is only ever written by share ingestion. The app's own
`insertLibraryEntry` hardcodes `source_kind: 'search'` with no URL, so **a game the
user searched for has no "found on" line at all.** The differentiator only fires on
games that arrived via a share.

### 3b. `?track=0` on game detail

`GET /games/:id` records a "recently viewed" for the caller as a side effect. That is
correct for a real detail-screen view and wrong for a prefetch, a background refresh
or anything that fetches a game the user is not looking at. Pass `?track=0` on those.

### 3c. The wishlist is still local-only

"Saved" across the Library and Add screens reads `useWishlistStore` — zustand plus
AsyncStorage, on-device. The server side has existed since 11 September:
`wishlist_entries`, straight PostgREST, owner-only RLS, same pattern as the library
sync you shipped on 10 September. Shapes are in `technical-notes-for-sola.md` §2.

### 3d. The 50-game free cap is not enforced anywhere

Worth stating plainly because it is easy to assume otherwise: there is **no
server-side enforcement** of the free-tier cap. Nothing stops a free account holding
500 games. If the app is treating the cap as enforced, it isn't.

---

## 4. What the backend still owes

- **Push notifications do not send yet.** The sweep now runs every minute and
  authenticates correctly, but it needs `ONESIGNAL_APP_ID` as well as the REST key,
  and only the key has been set. Until that lands the sweep idles and reports
  `ONESIGNAL credentials not configured`. Nothing for you to do; do not wire a
  notification UI expecting deliveries.
- **Release-day notifications** now actually fire on a schedule (the sweep had never
  run until today). The `game_release` notification shape and the null-actor branch
  your renderer needs are in `technical-notes-for-sola.md` §14.

## Questions

Anything in §1 or §2 that fights your layout, say so early — the count-beside-hours
rule is a product decision we can rephrase, but not one we can drop.
