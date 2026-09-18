# The long-press quick view — description and background art

**18 Sep 2026.** Brief: Paul's mock of a long-press "quick view" card (cover, title,
two lines of prose, status, platform icons, Save), Sola's "we should do a description
from our end", and `task.md`'s question about a video/GIF or second image sitting
behind the cover.

Every number below was measured against the live catalog or the live IGDB API on
18 Sep, not read off documentation. The three scripts are in `scripts/quickview-lab/`
(`npm run qv:assets`, `qv:ratios`, `qv:videos`).

> **DECIDED 18 Sep, same day, by the user — read this before the analysis below.**
>
> - **Description: serve the raw IGDB `summary`. The app truncates it.** Model-written
>   blurbs are **declined**. §2c option C is closed; do not re-propose it.
> - **Background: closed, nothing owed.** The app **already** blurs the cover behind
>   the game detail screen — confirmed from a screenshot of the live build. §3d's
>   option 3 was not a suggestion, it was already shipped. **No artwork fetch, no
>   `artwork_url` backfill.** §3 is kept as the record of why, and because §3e found a
>   real problem that outlives this feature.
>
> That leaves the backend owing exactly **one** thing for this card: return `summary`
> (§2d). The schema reconciliation in §3e is still owed, but on its own merits.

---

## 0. The answer in one paragraph

**The description can ship, with a caveat that changes the design.** 97.2% of the
catalog already carries IGDB's `summary` — it is stored, it is just not returned by
any endpoint. But it is a *paragraph* (median 233 characters), not the two lines in
the mock, and the obvious fix — "take the first sentence" — produces `1998.` for
Half-Life 2 and a mid-word cut for roughly half of the popular catalog. **A still
background can ship** for essentially the whole catalog, from IGDB screenshots, at
one fixed 940×529 crop. **A video or GIF background cannot ship** — not because
IGDB is missing something we could go and fetch, but because YouTube's own terms
forbid exactly the use `task.md` describes, and IGDB's animated assets are flattened
to a single frame before they leave the CDN. Along the way: **the live database has a
`games.artwork_url` column, and the poll/repost/share tables and the real `shelf_feed`,
that exist in no migration in this repo** — read §3e before writing any migration.
Details and alternatives below.

---

## 1. Where each field on the card comes from today

| Card element | Source | Status |
|---|---|---|
| Cover art | `games.cover_url`, `t_cover_big_2x`, 528×704 | **Live.** 90,261 / 91,815 rows (98.3%) |
| Title | `CatalogGame.title` | Live |
| **Two-line description** | `games.summary` | **Stored, returned by nothing.** §2 |
| "Playing Now" | `library_entries.status` | Live — the app already reads this table directly over PostgREST, so this needs no backend work |
| Platform icons | `CatalogGame.platforms[]` | Live |
| Save | `wishlist_entries` | Live since 11 Sep |
| **Background art** | `games.artwork_url` | **Exists live, 46 rows of 91,815, and is in no migration in this repo.** §3e |

So the card is two fields away from being servable, and one of those two is a
product decision rather than an engineering one.

### A note on the mock itself

The caption under *Horizon Forbidden West* in Paul's frame reads *"An epic tale of
life in America at the dawn of the modern age."* That is **Red Dead Redemption 2's**
summary, near-verbatim — IGDB's RDR2 row says *"the epic tale of outlaw Arthur
Morgan and the infamous Van der Linde gang, on the run across America at the dawn of
the modern age."* Horizon's real summary is *"Horizon Forbidden West continues Aloy's
story as she moves west to a far-future America to brave a majestic, but dangerous
frontier…"*

This is not a criticism of the mock — it is placeholder text and it tells us the one
thing we needed to know: **the target is ~60 characters over two lines, in a voice
that sells the game.** That length is the whole problem in §2.

---

## 2. The description

### 2a. What we already have

Measured 18 Sep over all 91,815 catalog rows:

| | Count | Share |
|---|---:|---:|
| Rows with `summary` | 89,210 | **97.2%** |
| Rows with `storyline` | 13,257 | 14.4% |
| Median `summary` length | 233 chars | |
| p90 `summary` length | 491 chars | |
| Longest `summary` | 9,844 chars | |

Quality, over the 17,057 rated games (`total_rating_count >= 5`) that have one:

| Signal | Count | Share |
|---|---:|---:|
| Contains a newline (must be collapsed before rendering) | 5,214 | 30.6% |
| Starts with the game's own title (redundant under the title) | 6,851 | 40.2% |
| Contains marketing junk ("pre-order", "season pass", …) | 40 | 0.2% |
| Contains a URL | 1 | 0.0% |
| Shorter than 60 chars | 204 | 1.2% |

**The text is clean.** IGDB summaries are not spam. The problem is length and shape,
not hygiene.

### 2b. "Just take the first sentence" does not work

First-sentence length over those 17,057 rated games:

| First sentence ≤ | Games | Share |
|---|---:|---:|
| 100 chars | 6,297 | 36.9% |
| 120 chars | 8,566 | 50.2% |
| 140 chars | 10,513 | 61.6% |
| 160 chars | 12,029 | 70.5% |

Median 120, p90 254. So a two-line card fed by first-sentence-truncation renders a
complete thought for about half the games people actually open, and a mid-sentence
ellipsis for the rest. Here is the derivation run for real, over the 15 most-rated
games (collapse whitespace → first sentence → cut at 130 chars on a word boundary):

| Game | What the card would say |
|---|---|
| Grand Theft Auto V | "…a sprawling sun-soaked metropolis struggling to stay afloat in…" |
| The Witcher 3 | "…is an open-world action role-playing game developed by CD Projekt Red." |
| The Elder Scrolls V: Skyrim | "Skyrim reimagines and revolutionizes the open-world fantasy epic, bringing to life a complete virtual world open for you to…" |
| Red Dead Redemption 2 | "…the infamous Van der Linde gang, on the run across America…" |
| God of War | "God of War is the sequel to God of War III as well as a continuation of the canon God of War chronology." |
| The Last of Us | "…is a third-person action-adventure game featuring a mix of exploration, stealth and combat." |
| **Half-Life 2** | **"1998."** |
| BioShock | "BioShock is a horror-themed first-person shooter set in a steampunk underwater dystopia." |

Three distinct failure modes, all on the *most popular* games in the catalog:

1. **`1998.`** — the entire card description for Half-Life 2. Its summary opens with
   a dateline.
2. **Wikipedia voice.** Witcher 3, God of War and The Last of Us open by naming a
   genre and a developer. That is metadata, not the "epic tale" register Paul's mock
   is written in.
3. **Mid-sentence cuts** on anything over 130 characters — half the catalog.

### 2c. The three options

**A. Return `summary` raw and let the app clamp to two lines.**
Cost: one migration, half a day. The app gets the real paragraph and CSS truncates
it. Honest, zero risk of invented facts, and it is the fastest thing we can ship.
Downside: the card shows the first two lines of a paragraph, which is the same
mid-sentence cut as above, just done client-side, plus 40% of cards open by
repeating the title that is printed directly above them.

**B. Derive a `blurb` column server-side** (collapse whitespace, strip a leading
`"<Title> is a/the …"`, first sentence, cap at ~130 chars).
Cost: one migration plus a backfill, a day. Fixes the whitespace and the repeated
title. Does **not** fix `1998.` and does not fix the Wikipedia voice, because that
information is not in the source text.

**C. Write our own one-liner with a model, grounded on the IGDB summary.**
This is what Sola is actually asking for — "a description from **our end**". One
batch job over the catalog, each blurb grounded on the row's real title, year,
genres and summary, constrained to ≤ 90 characters and to the "what is this game
like" register.

Cost, at current list prices with the Batch API's 50% discount (Haiku 4.5 $1/$5 per
MTok, Sonnet 5 $2/$10), assuming ~400 input and ~40 output tokens per game:

| Scope | Model | Cost |
|---|---|---:|
| 17,106 rated games | Haiku 4.5 (batch) | **~$5** |
| 17,106 rated games | Sonnet 5 (batch) | ~$10 |
| 91,815 full catalog | Haiku 4.5 (batch) | ~$28 |
| 91,815 full catalog | Sonnet 5 (batch) | ~$55 |

**DECIDED 18 Sep: A. B and C are both closed.** The backend returns the raw
`summary`; the app truncates it to fit. The consequences are accepted knowingly, and
are worth writing down so nobody re-files them as bugs:

- Half-Life 2's card will show the opening of a paragraph that starts `1998.`
- ~40% of cards will open by repeating the title printed directly above them.
- 30.6% of summaries contain newlines — **the app must collapse whitespace before
  clamping**, or the two-line clamp will spend a line on a blank.
- Truncation happens client-side, so where the cut falls is the app's choice, not the
  server's. If Sola wants an ellipsis it is his to add.

The original recommendation was A now, C later. C is declined; A is the whole scope.

**One caution that has to be written down before C happens.**
`docs/research/semantic-search.md` §4b specifies LLM enrichment as **retrieval-only**
— *"It should never be shown to a user as fact; it exists to be embedded. A wrong
sentence then costs one bad search result, not a visible lie."* Option C puts
model-written text on the screen, under a real game's cover, where a user will read
it as ours. That is a different risk posture and it is Josh's call, not a technical
detail. Mitigations if it goes ahead: ground every blurb on the real summary, cap it
hard, forbid character names and plot claims, and spot-check a sample by hand before
it goes live. Do **not** reuse the search-enrichment paragraphs for this — they were
written to a different brief with a different tolerance for being wrong.

### 2d. What shipping A costs, concretely

There is a precedent from 17 Sep that this follows exactly —
`20260917150000_catalog_release_precision.sql` carried `release_precision` out to the
app. Same shape:

1. `alter type shelf_catalog_row add attribute summary text;` (appends — attribute
   order matters, position is cosmetic since PostgREST serialises by name).
2. `create or replace` the three `SETOF shelf_catalog_row` functions
   (`shelf_search_games`, `shelf_popular_games`, `shelf_roulette`) with the extra
   column, plus the three `returns table` ones
   (`shelf_recently_viewed`, `shelf_watched_games`, `shelf_popular_with_friends`) —
   verified against `pg_proc` on the live database, not read off the migrations.
   A `create or replace` re-grants anon — check that, it has bitten before.
3. Add `summary` to `/games/:id`'s column list and to `CatalogRow` / `toCatalogGame`
   in `_shared/catalog-game.ts`.

Payload cost: a median 233 extra characters on every catalog row in every list
response. A 20-item `/games/popular` page grows by roughly 5 KB. That is real on a
phone and it is the argument for a short derived field over the raw paragraph if we
later find list endpoints feeling heavy — measure before optimising.

---

## 3. The background image

### 3a. What IGDB has — measured

Coverage over three 400-game cohorts drawn from real catalog rows
(`npm run qv:assets`):

| Cohort | artwork | screenshot | artwork **or** screenshot | video |
|---|---:|---:|---:|---:|
| Top 400 by rating count | 97.0% | 100.0% | **100.0%** | 100.0% |
| 400 sampled from rated (≥5) | 91.5% | 100.0% | **100.0%** | 100.0% |
| 400 from the unrated long tail | 97.3% | 99.3% | **99.5%** | 56.5% |

**Screenshots are the reliable asset, not artworks.** That is the opposite of what
`task.md`'s research assumed — it calls `/artworks` "the primary source" and
screenshots "a fallback".

### 3b. Why artworks are the wrong layer

Ratio distribution from the endpoints' own `width`/`height` fields, over the 600
most-rated catalog games (`npm run qv:ratios`; the screenshot sample is truncated by
IGDB's 500-row page cap, so read it as indicative):

| | artworks (2,744 assets) | screenshots (3,000 assets) |
|---|---:|---:|
| Median ratio | 1.148 | **1.778** (16:9) |
| p10 → p90 | 0.750 → 2.100 | 1.333 → 1.778 |
| Min / max | 0.458 / **12.800** | 0.563 / 3.000 |
| Portrait (<1.0) | **22.7%** | 1.1% |
| ~16:9 | 25.3% | **66.3%** |
| Ultrawide (>2.2) | 11.2% | 0.6% |

`artworks` is a crowd-uploaded grab bag: a fifth of it is portrait, a tenth is
ultrawide banner, and one asset is 12.8:1. **Silent Hill 2's top artwork is a
scanned magazine poster** carrying its own logo, its own copyright line
(*"© RATIO'S SILENT HILL COLLECTION"*) and a URL. Cropped to landscape for a card
background it becomes an unreadable close-up of two characters' legs. Screenshots
are frames from the game and behave.

### 3c. The size token that solves the ratio problem

Measured by downloading the real files:

| Token | Behaviour |
|---|---|
| `t_1080p` | **Fits** inside 1920×1080, preserving aspect. A portrait artwork stays portrait. Upscales small sources. |
| `t_screenshot_big` | **Always 940×529 (16:9), centre-cropped.** Verified visually against a 640×480 source: the HUD at the top and bottom is cropped away, nothing is squashed. |

So `t_screenshot_big` gives one fixed landscape frame for every asset, artwork or
screenshot, with no client-side cropping and no letterboxing. Weights measured at
27–103 KB per image — acceptable behind a card that only appears on a long press.

**A third of assets are under 720px tall**, so `t_1080p` would upscale them. One more
reason to serve the 940×529 crop rather than the biggest thing available.

### 3d. What I would actually build

Fill the `artwork_url` column that already exists (§3e) — do not add a second one —
with **one** background URL per game, resolved in this order:

1. first `screenshot` at `t_screenshot_big` — ~100% of rated games, ~99% overall;
2. first `artwork` at `t_screenshot_big` — for the handful with no screenshot;
3. **nothing** — and the app falls back to a blurred, darkened copy of the cover it
   is already showing. Free, needs no new data, covers 98.3% of the catalog by
   itself, and is what most storefronts do anyway.

**DECIDED 18 Sep: option 3, and it is already live.** The app blurs the cover behind
the game detail screen today — confirmed from a screenshot of the running build
(GTA: Vice City, cover blurred edge-to-edge behind the card). So steps 1 and 2 above
are **not being built**: no screenshot backfill, no `artwork_url` fill, nothing
fetched. This section stays as the record of what was measured and why the cheap
answer was also the right one.

Storage: one ~70-character URL × 91,815 rows ≈ 6 MB. The database is at 315 MB of the
500 MB free tier, so this is affordable — but note the pgvector plan in
`semantic-search.md` §7 budgets ~193 MB for embeddings over the full catalog, and
315 + 193 already exceeds 500. The background column is not what breaks that budget,
but it should not be spent without knowing the budget is tight.

Fetch cost: the assets do **not** require a full re-seed. A backfill walking
`/screenshots` with `where game = (…100 ids…)` is ~918 requests at IGDB's 4 req/sec —
about four minutes. Half a day of work including the migration.

### 3e. There is already an `artwork_url` column, and it is not in this repo

Found while sizing the migration, and it needs to be read before anyone writes one.

`games.artwork_url text` **exists on the live database**. It appears in no file under
`supabase/migrations/`, in no edge function, and in no script. Neither does the live
`shelf_feed`, which returns `game_artwork, game_year, game_genres, game_rating,
game_platforms, poll, repost_count, share_count, reposted_by_handle …` — the version
in `20260908213500_social_feed.sql` returns three game fields and no poll or repost
columns at all. Nor do the live tables `post_polls`, `post_reposts` and `post_shares`.

Its state:

- **46 of 91,815 rows filled (0.05%)**, and those 46 are *exactly* the 46 games that
  appear in a `posts` row. It was backfilled to make the demo feed render, nothing
  more.
- The URLs use `t_screenshot_huge` — measured at **1280×720, 126 KB**. That is the
  same fixed-16:9-centre-crop family as the `t_screenshot_big` recommended in §3c,
  just twice the weight. For a card that appears on a long press, 940×529 at ~30–80 KB
  is the better pick; the *convention* here is already right.

Three consequences (the first is now moot for this feature — the background decision
of 18 Sep means nothing fills this column — but it still governs any future attempt):

1. **Background work should fill this column, not add a second one.** A
   `background_url` alongside a half-filled `artwork_url` is how a catalog ends up
   with two columns nobody trusts.
2. **`npm run db:reset` would destroy all of it** — the column, the four-extra-field
   `shelf_feed`, the three poll/repost/share tables. Anyone running a local reset
   from these migrations gets a database that the live app's feed code cannot talk to.
3. **Something is applying schema to production outside this repo.** That is worth
   asking about before the next migration goes up, because a `create or replace
   function shelf_feed(...)` written from the repo's copy would silently delete six
   columns the app is already reading.

This is the fifth time dead or undeclared config in this project has been found
asserting something untrue about the live system. The fix here is small: write a
migration that declares `artwork_url` and the live `shelf_feed`/poll tables as they
actually are, so the repo and the database agree again — and do it *before* the
quick-view migration, not as part of it.

---

## 4. Video and GIF backgrounds — no

`task.md` asks for "a video or a gif that we can use as a background". Four separate
findings, each independently fatal:

**1. IGDB hosts no video files.** Confirmed by dumping the live schema:
`game_videos` carries exactly `{id, game, name, video_id, checksum}`. `video_id` is a
YouTube id. There is nothing else to fetch. `task.md`'s research is right on this
point.

**2. The YouTube ids are healthy — and unusable.** 120 of 120 sampled trailer ids
from the most-rated games returned 200 from YouTube's oEmbed endpoint: none deleted,
none private, none embedding-disabled (`npm run qv:videos`). But YouTube's *Required
Minimum Functionality* terms say an embedded player "must not display overlays,
frames, or other visual elements in front of any part of a YouTube embedded player,
including player controls", must be at least 200×200, and must remain visible and
unobscured. **A YouTube player with a game cover card sitting on top of it is the
exact thing those terms prohibit.** This is not a grey area we can design around;
it's the one rule the feature would have to break to exist.

**3. IGDB's `animated` flag is metadata, and it lies about delivery.**
`task.md`'s research says the flag is "predominantly used to flag rare exceptions".
It is real — `where animated = true` returns rows on both endpoints — but:
- Across **all of IGDB**, 88 animated artworks and 445 animated screenshots
  (both capped at the 500-row page limit, so the true figure is in the hundreds).
- Those belong to 327 distinct IGDB games, of which **60 are in our catalog** —
  0.065% of 91,815.
- And they do not arrive animated. `sc8jkt.gif` at `t_1080p` is 1920×1080 with
  **zero** GIF graphic-control blocks — a single frame. Same at `t_720p` and
  `t_screenshot_huge`. `t_original` returns a **PNG**. The CDN flattens them. The
  `.gif`, `.webp`, `.png` and `.jpg` extensions all return 200 with the matching
  content type, which makes this easy to mistake for a working animated pipeline —
  it is not one.

**4. Steam does have real video, for about half the library.** `store.steampowered.com`
`/api/appdetails` returns DASH and HLS manifests per trailer (verified live on
The Witcher 3 — `hls_264_master.m3u8`, `dash_av1.mpd`, `dash_h264.mpd`; the old flat
`webm`/`mp4` keys are gone). We already hold a Steam appid for **8,899 of 17,106
rated games (52.0%)** and 66,625 of the full catalog. So a video background is
*technically* reachable for half the popular catalog. Against it: that endpoint is
undocumented and unofficial, the assets are Valve's under Steam's terms, coverage
misses precisely the games people care about (no Nintendo, no PlayStation
exclusives — same 50% ceiling the cover-art appendix in `semantic-search.md` hit),
and a 90-second trailer with a publisher logo intro is not a two-second ambient loop.
It would need to be trimmed, re-encoded and hosted by us, which is a media pipeline
this project does not have and cannot pay for on a free tier.

**Conclusion: still image or nothing.** If the design genuinely needs motion, the
honest version is a slow Ken Burns pan on the still — pure client-side, free, 100%
coverage, and it breaks nobody's terms.

---

## 5. Build order, if this is greenlit

| # | Work | Size | Blocks on |
|---|---|---|---|
| 1 | Return `summary` on `CatalogGame` (§2d) | half a day | nothing |
| 2 | Blurred-cover background, app-side | zero backend | Paul choosing it over real art |
| 3 | Reconcile the migrations with the live schema (§3e) | half a day | nothing — owed regardless |
| ~~4~~ | ~~Fill `artwork_url` from IGDB screenshots~~ | — | **CANCELLED 18 Sep** — blurred cover already live |
| ~~5~~ | ~~Model-written blurbs~~ | — | **DECLINED 18 Sep** |

**The whole quick-view backend is item 1.** Item 2 is already shipped in the app.
Item 3 is unrelated housekeeping that this session happened to uncover.

## 6. Decisions — all closed 18 Sep

| Question | Answer |
|---|---|
| Blurred cover or real key art? | **Blurred cover.** Already live in the app. |
| Raw IGDB paragraph, clamped by the app? | **Yes.** §2c option A. |
| ~$5 for model-written blurbs? | **No.** |
| Video / GIF background? | **Impossible** — §4, not a budget question. |

Still owed to people, and not decided here:

- **Sola:** when §2d lands, `CatalogGame` grows one optional `summary` and every
  endpoint returns it at once. He owes the whitespace collapse before clamping
  (30.6% of summaries contain a newline) and the ellipsis, if he wants one.
- **Josh, two things this session raised that nobody has answered:**
  1. **IGDB attribution and commercial use.** The app already carries *"Game data and
     cover art from IGDB.com"* on the detail screen, which is the right instinct —
     IGDB asks for credit. But secondary sources also state the API is free **for
     non-commercial use**, with commercial projects directed to a partnership.
     Prysm is going paid ($4.99 / $29.99). **I could not verify this against the
     primary source** — `api-docs.igdb.com` and `igdb.com/api` both return 403 to an
     automated fetch (Cloudflare), so this needs a human with a browser reading the
     actual terms. Do not treat the above as settled either way; it is a flag, not a
     finding. The credit line should probably also mention descriptions once §2d
     ships, since we would then be displaying IGDB prose, not just data and covers.
  2. **Time-to-beat has visibly wrong values on flagship games** — see §7.
- **Whoever applied `games.artwork_url`, the live `shelf_feed` and the poll/repost/
  share tables** (§3e) — I need to know, because the next migration has to be written
  against what is really there, and a local `db:reset` currently produces a database
  the app cannot use.

---

## 7. Side finding: `ttb_*` carries values that are visibly wrong — FIXED 18 Sep

**Status: guard written, backfill written, verification written and passing on the
mapper half. The migration has NOT been applied — that needs `! npm run db:push`.**

- `_shared/mapping.ts` — `guardTtbOrder()`, applied inside `mapIgdbGame`, so future
  seeds are clean.
- `supabase/migrations/20260918110000_ttb_monotonicity.sql` — clears the 153 rows
  already written, and recomputes `session_fit` for the 5 rows whose value came from
  the time-to-beat branch.
- `scripts/verify-ttb.ts` (`npm run verify:ttb`) — 15/15 mapper checks pass; the
  catalog half correctly FAILS with `153 left` and names Vice City until the migration
  is applied. That is the check doing its job, not a defect.

Not part of the brief. Spotted on the screenshot the user sent to settle the
background question — the live detail screen for **Grand Theft Auto: Vice City** reads
**"135h to beat"**. Vice City is a ~30-hour game.

The stored row, queried the same day:

| column | value |
|---|---|
| `ttb_hastily_hours` | **876.0** |
| `ttb_normally_hours` | 134.6 |
| `ttb_completely_hours` | 181.8 |
| `ttb_count` | 13 |
| `session_fit` | `high` |

**`hastily` is larger than `completely`.** That is not a plausible reading of any
game; it is corrupt crowd data that the existing guard did not catch.

`mapping.ts` already has a plausibility filter — `TTB_MAX_PLAUSIBLE_HOURS = 1000`,
added because values ≥ 10000 overflow `numeric(5,1)` and killed a whole 500-row seed
page. It is doing its job. It just only catches the *absurd* tail, not the merely
wrong: 876 < 1000, so it passed.

Scope, over the 5,106 catalog rows that have a `ttb_normally_hours` at all:

| Check | Rows | Share of rows with a value |
|---|---:|---:|
| `hastily > normally` (internally contradictory) | 111 | 2.2% |
| `normally > completely` (internally contradictory) | 188 | 3.7% |
| `normally > 200h` | 52 | 1.0% |
| `normally > 500h` | 23 | 0.5% |
| Derived from a **single** submission | 2,947 | **57.7%** |
| Derived from ≤ 3 submissions | 4,290 | 84.0% |

Two separate problems, and the second is the bigger one:

1. **A monotonicity guard is missing.** `hastily <= normally <= completely` is a
   property the data must have. ~300 rows break it and are demonstrably wrong; the
   cheap fix is to null the whole triple when the ordering is violated, exactly as
   the 1000h guard nulls an implausible one. Vice City's 876h would be caught by this.
2. **57.7% of surviving time-to-beat values come from one person's submission**, and
   84.0% from three or fewer.
   That is not a bug, it is what IGDB has — but "135h to beat" is presented to the
   user as fact, with no sample size next to it, and it feeds `session_fit` and
   `shelf_roulette`'s `size` filter. Whether to show a number backed by n=1 at all is
   a product question for Paul, not an engineering one.

The first is fixed (above). **The second is not, and is not an engineering call** —
whether to show a duration backed by one person at all, or to show it with its sample
size, is Paul's. `ttb_count` is already stored and already on the row, so the app can
render it the moment anyone decides what it should say.

Deliberately kept out of the quick-view migration: this is a separate change with a
separate reason, and mixing them would make either one hard to revert.
