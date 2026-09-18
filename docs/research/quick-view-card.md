# The long-press quick view — description and background art

**Researched 18 Sep 2026 daytime, shipped 18 Sep night.** Brief: Paul's mock of a
long-press "quick view" card (cover, title, two lines of prose, status, platform
icons, Save), Sola's "we should do a description from our end", and `task.md`'s
question about a video/GIF or second image sitting behind the cover.

Every number below was measured against the live catalog or the live IGDB API on
18 Sep, not read off documentation. The three scripts are in `scripts/quickview-lab/`
(`npm run qv:assets`, `qv:ratios`, `qv:videos`).

> **SHIPPED 18 Sep night — pushed, deployed, verified live. Read this before the
> analysis below.**
>
> - **Description: the raw IGDB `summary` is returned. The app truncates it.**
>   Model-written blurbs were declined. §2c option C is closed; do not re-propose it.
> - **Background: closed, nothing owed.** The app already blurs the cover behind
>   the game detail screen. No artwork fetch, no `artwork_url` backfill by this
>   feature. §3 is kept as the record of why, and because §3e found a real problem
>   that outlived this feature.
> - **The undeclared live schema (§3e) is declared** — migration
>   `20260918120000_declare_live_social_schema.sql`. It turned out to be much bigger
>   than first estimated, and it turned up `game-artwork` — the edge function behind
>   `games.artwork_url` — which was planned in an earlier session as the answer to
>   this same `task.md` background-art question, but had never had its source added
>   to this repo. Now imported: `supabase/functions/game-artwork/index.ts`.
> - **The time-to-beat fix (§7) was already applied before the shipping session
>   started.** Confirmed live and via `npm run verify:ttb`.
> - **One more gap, found and fixed the same night, not in the original brief:**
>   `_shared/games-by-ids.ts` — the hydration path behind vague search — was missing
>   both `summary` and `release_precision`. See §2e.

## START HERE if you are picking this up cold

**Everything in this document is decided AND shipped.** Nothing below needs a
meeting, and nothing below needs building — this section is now a map of what
happened and where the evidence for it lives.

| Item | Where | Status |
|---|---|---|
| Return `summary` on `CatalogGame` | §2d | **SHIPPED** — migration `20260918130000_catalog_summary.sql` |
| Fix `_shared/games-by-ids.ts`'s own gap (vague search's hydration) | §2e | **SHIPPED**, same night, found while wiring the above |
| Apply the time-to-beat fix | §7 | **SHIPPED** — already applied before this session started |
| Declare the undeclared live schema | §3e | **SHIPPED** — migration `20260918120000_declare_live_social_schema.sql` |

Do **not** rebuild any of this: model-written blurbs (§2c, declined), a derived
`blurb` column (§2c, rejected), a background-art fetch (§3d, the app already blurs the
cover), a video or GIF background (§4, impossible — YouTube's terms, not our budget).

Reproduce any number here with `npm run qv:assets`, `qv:ratios`, `qv:videos`
(`scripts/quickview-lab/`). The database figures come from the live project; re-run
them rather than trusting these tables if more than a few weeks have passed.

`docs/STATUS.md` § "PICK UP HERE" carries the same list in project-wide priority
order. **`docs/quick-view-card-for-sola.md` is the file that actually goes to
Sola** — one self-contained doc covering both `summary` and `game-artwork`, the same
way `docs/onboarding-for-sola.md` covers onboarding. Don't send him
`docs/technical-notes-for-sola.md` or this research doc; both are for whoever
touches the backend next, not for him.

---

## 0. The answer in one paragraph

**The description shipped, with the caveat that changed the design.** 97.2% of the
catalog carries IGDB's `summary`, and every `CatalogGame`-returning endpoint now
returns it. It is a *paragraph* (median 233 characters), not the two lines in the
mock — the app truncates it, and the obvious naive fix, "take the first sentence,"
would have produced `1998.` for Half-Life 2 and a mid-word cut for roughly half the
popular catalog, so it was rejected rather than built. **No still background
shipped** — the app already blurs the cover, which covers 98.3% of the catalog for
free and was already live before this feature started. **No video or GIF
background shipped** — not because IGDB is missing something fetchable, but because
YouTube's own terms forbid exactly the use `task.md` describes, and IGDB's animated
assets are flattened to a single frame before they leave the CDN. Along the way:
**the live database held a `games.artwork_url` column, the poll/repost/share tables,
and a real `shelf_feed` that existed in no migration here — all now declared** (§3e),
and that work turned up the mechanism behind the column: a live edge function,
`game-artwork`, planned in an earlier session as the answer to this same
background-art question, whose source had never been added to this repo. Now
imported. Details below, and the app-facing contract is in
`docs/quick-view-card-for-sola.md`.

---

## 1. Where each field on the card comes from today

| Card element | Source | Status |
|---|---|---|
| Cover art | `games.cover_url`, `t_cover_big_2x`, 528×704 | Live |
| Title | `CatalogGame.title` | Live |
| **Two-line description** | `games.summary` → `CatalogGame.summary` | **Live, shipped 18 Sep night** |
| "Playing Now" | `library_entries.status` | Live — the app already reads this table directly over PostgREST |
| Platform icons | `CatalogGame.platforms[]` | Live |
| Save | `wishlist_entries` | Live since 11 Sep |
| **Background art** | `games.artwork_url` | **Exists live; this feature owes it nothing extra (§3d). Filled on demand by `game-artwork`, planned in an earlier session and now declared in the repo — see §3e and `docs/quick-view-card-for-sola.md`.** |

The card is fully servable from `CatalogGame` as of 18 Sep night: cover, title,
description, playing-now status, platforms and Save all come from data the app
already has or now has.

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

### 2c. The three options considered

**A. Return `summary` raw and let the app clamp to two lines. CHOSEN, SHIPPED.**
Cost: one migration, half a day. The app gets the real paragraph and CSS truncates
it. Honest, zero risk of invented facts, and the fastest thing that could ship.
Downside, accepted knowingly: the card shows the first two lines of a paragraph,
which is the same mid-sentence cut as above just done client-side, plus 40% of cards
open by repeating the title printed directly above them.

**B. Derive a `blurb` column server-side** (collapse whitespace, strip a leading
`"<Title> is a/the …"`, first sentence, cap at ~130 chars). **Rejected.** Would fix
the whitespace and the repeated title, but not `1998.` and not the Wikipedia voice,
because that information is not in the source text.

**C. Write our own one-liner with a model, grounded on the IGDB summary.**
**Declined.** This is what Sola was actually asking for — "a description from **our
end**" — one batch job over the catalog, each blurb grounded on the row's real
title, year, genres and summary, constrained to ≤ 90 characters.

Cost, at current list prices with the Batch API's 50% discount (Haiku 4.5 $1/$5 per
MTok, Sonnet 5 $2/$10), assuming ~400 input and ~40 output tokens per game:

| Scope | Model | Cost |
|---|---|---:|
| 17,106 rated games | Haiku 4.5 (batch) | ~$5 |
| 17,106 rated games | Sonnet 5 (batch) | ~$10 |
| 91,815 full catalog | Haiku 4.5 (batch) | ~$28 |
| 91,815 full catalog | Sonnet 5 (batch) | ~$55 |

**DECIDED 18 Sep, and shipped as A: B and C are both closed.** The consequences of A
are accepted knowingly, and are worth keeping written down so nobody re-files them as
bugs:

- Half-Life 2's card shows the opening of a paragraph that starts `1998.`
- ~40% of cards open by repeating the title printed directly above them.
- 30.6% of summaries contain newlines — **the app must collapse whitespace before
  clamping**, or the two-line clamp spends a line on a blank. Told to Sola directly
  (§2d, `docs/technical-notes-for-sola.md`).
- Truncation happens client-side, so where the cut falls is the app's choice, not the
  server's. If Sola wants an ellipsis, it is his to add.

**One caution, written down before anyone revisits C.**
`docs/research/semantic-search.md` §4b specifies LLM enrichment as **retrieval-only**
— *"It should never be shown to a user as fact; it exists to be embedded. A wrong
sentence then costs one bad search result, not a visible lie."* Option C would put
model-written text on the screen, under a real game's cover, where a user reads it as
ours. That is a different risk posture and it is Josh's call, not a technical detail.
Mitigations if it is ever revisited: ground every blurb on the real summary, cap it
hard, forbid character names and plot claims, and spot-check a sample by hand before
it goes live. Do **not** reuse the search-enrichment paragraphs for this — they were
written to a different brief with a different tolerance for being wrong.

### 2d. What shipping A cost, concretely — SHIPPED 18 Sep night

Followed the precedent from 17 Sep exactly —
`20260917150000_catalog_release_precision.sql` carried `release_precision` out to the
app the same way. Migration: `20260918130000_catalog_summary.sql`.

1. `alter type shelf_catalog_row add attribute summary text;` — appends; attribute
   order matters for the functions that select from it, position is cosmetic since
   PostgREST serialises by name.
2. `create or replace` on the three `SETOF shelf_catalog_row` functions
   (`shelf_search_games`, `shelf_popular_games`, `shelf_roulette`); `drop` + `create`
   on the three `returns table` ones (`shelf_recently_viewed`, `shelf_watched_games`,
   `shelf_popular_with_friends`) — that count of 3 + 3 was confirmed against `pg_proc`
   on the live database, not read off the migrations. Every one of the six was
   re-granted to `authenticated` and revoked from `anon`/`public` in the same
   migration — `create or replace` resets that, and it has bitten this project
   before.
3. Added `summary` to `/games/:id`'s column list and to `CatalogRow` / `toCatalogGame`
   in `_shared/catalog-game.ts`.

**The step this precedent didn't warn about: five edge functions had to be
REDEPLOYED, not just the migration pushed.** `games`, `search`, `roulette`,
`share-resolve` and `vague-search` each bundle their **own copy** of
`_shared/catalog-game.ts` at deploy time — Supabase edge functions are not a shared
runtime, each one is its own bundle. Editing the shared file locally and pushing the
migration was not enough: `/search` kept returning rows with no `summary` until
`search` itself was redeployed, even though the RPC underneath it already carried the
column, because the *deployed* `search` was still running its old, pre-summary copy
of `toCatalogGame()`. Caught by a direct authenticated fetch against the deployed
endpoint, not by `npm run verify:functions` alone (it predates this feature and
doesn't assert on `summary`).

**Checklist for the next field added to `CatalogGame`:** grep
`supabase/functions/**/*.ts` for `catalog-game.ts` imports, and redeploy every one of
them, not just the function whose route obviously changed. As of 18 Sep night that
list is `games`, `search`, `roulette`, `share-resolve`, `vague-search` — five
functions, not one.

Verified live: `npm run verify:functions` and `npm run verify:roulette` both pass
clean (no regression against the pre-existing suites), plus a direct authenticated
fetch confirming `summary` reaches `/games/popular`, `/games/:id` and `/search`.

Payload cost: a median 233 extra characters on every catalog row in every list
response. A 20-item `/games/popular` page grows by roughly 5 KB. Accepted knowingly —
real on a phone, and the argument for a short derived field over the raw paragraph if
list endpoints are ever measured as feeling heavy.

### 2e. The gap this left in vague search — found and fixed the same night

`_shared/games-by-ids.ts` (`catalogGamesByIds()`) is a **second** hydration path,
separate from the RPC-based one every list endpoint uses: it takes a bare list of
game ids and turns them into `CatalogGame`s with a plain `.select()` against `games`.
Vague search's job responses (`/vague-search`, both the `POST` and `GET` shapes) are
hydrated through it, because a job row stores candidate ids, not full rows.

It was never updated when `release_precision` shipped on 17 Sep, and it was still
missing when `summary` shipped 18 Sep — a pre-existing gap this migration's
documented scope didn't cover, flagged rather than silently fixed in the first pass.
**Fixed the same night**, one line: added `release_precision` and `summary` to its
column list. `share-resolve` does **not** use this file — it hydrates through
`shelf_search_games` directly, same as `/search` — so it only needed the
`catalog-game.ts` redeploy from §2d, not this fix.

Both `share-resolve` and `vague-search` were redeployed with the fix. Verified live:
a cache-hit `/vague-search` response now carries both `summary` and
`releasePrecision` on every candidate.

**Why this matters beyond the one-line fix:** it is the second time in two days a
`CatalogGame`-shaped response turned out to come from code outside the RPC path
everyone remembers to update. If a third one is ever added, grep for
`toCatalogGame(` across `supabase/functions/`, not just for the RPC names.

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

### 3d. What was considered and NOT built for this feature

Fill the `artwork_url` column that already existed (§3e) — do not add a second one —
with **one** background URL per game, resolved in this order:

1. first `screenshot` at `t_screenshot_big` — ~100% of rated games, ~99% overall;
2. first `artwork` at `t_screenshot_big` — for the handful with no screenshot;
3. **nothing** — and the app falls back to a blurred, darkened copy of the cover it
   is already showing. Free, needs no new data, covers 98.3% of the catalog by
   itself, and is what most storefronts do anyway.

**DECIDED 18 Sep: option 3, and it was already live.** The app blurs the cover behind
the game detail screen today — confirmed from a screenshot of the running build
(GTA: Vice City, cover blurred edge-to-edge behind the card). So steps 1 and 2 above
were **not built for this feature**: no screenshot backfill, no `artwork_url` fill,
nothing fetched by the quick-view work. This section stays as the record of what was
measured and why the cheap answer was also the right one — and see §3e for
`game-artwork`, which already does exactly this (built in an earlier session for the
same `task.md` ask) and is now declared in this repo.

Storage, for the record: one ~70-character URL × 91,815 rows ≈ 6 MB. The database is
at 315 MB of the 500 MB free tier, so this is affordable — but note the pgvector
plan in `semantic-search.md` §7 budgets ~193 MB for embeddings over the full catalog,
and 315 + 193 already exceeds 500. The background column is not what breaks that
budget, but it should not be spent without knowing the budget is tight.

### 3e. There was already an `artwork_url` column, and it wasn't in this repo — DECLARED and IMPORTED 18 Sep night

Found 18 Sep daytime while sizing the migration; declared 18 Sep night via
`supabase/migrations/20260918120000_declare_live_social_schema.sql`, pushed and
verified live.

`games.artwork_url text` existed on the live database, in no file under
`supabase/migrations/`. Neither did the live `shelf_feed`, nor the live tables
`post_polls`, `post_reposts` and `post_shares`.

**What this section originally said, and what turned out to be wrong (undercounted,
not incorrect in kind):** it described `shelf_feed` as returning "six more columns"
than `20260908213500_social_feed.sql` defines. Querying `pg_proc` directly while
writing the declaration migration found the real number is **28 columns**, including
a whole friends-of-friends + trending-posts ranking tier (`network` and `popular`
CTEs) this repo never had at all, surfaced as a `reason` column
(`self`/`following`/`repost`/`network`/`popular`/`profile`). Also undeclared:
`post_poll_options`, `post_poll_votes`, a `posts.category` column, and three
functions running the whole poll feature (`shelf_poll`, `shelf_create_post`,
`shelf_vote_poll`) — **none of which had ever been revoked from `anon`**, unlike
every other `shelf_%` function in this project. Closed as part of the same
migration; no behaviour change for an authenticated caller.

**`games.artwork_url` itself is filled by `game-artwork`, an edge function that was
live on the project but had no source in this repo — not a mystery, a planning gap.**
It was planned in an earlier session as the direct answer to `task.md`'s
background-art question (the same brief this whole document analyses), built and
deployed, but its source was never committed here — the first sign of that was its
`created_at` sorting after every other function's last `updated_at` on the project.
**Imported 18 Sep night**: `supabase/functions/game-artwork/index.ts`, pulled
verbatim from the live deployment, declaring it the same way the schema above was
declared. The app-facing contract for it — request/response shape, how it resolves
an image, what it costs to call — is written up properly for the first time in
`docs/quick-view-card-for-sola.md` §2.

What it does, for anyone reading this doc rather than the contract doc:

- `POST game-artwork {"gameIds": string[]}` (50 max) → `{"artwork": {"<uuid>":
  "<url or ''>"}}`.
- Callable by any signed-in user (checks the JWT's `role` claim for `authenticated`
  or `service_role`), not only the service role — worth noting because most write
  paths built in this repo reserve shared-quota spending for the service role, but
  not a problem: it's meant to be called from the app.
- For each requested game with `artwork_url is null`, queries IGDB `screenshots`
  then `artworks` (the same fallback order §3d independently arrived at, and the
  same `t_screenshot_huge` size token noted below), writes the result back with
  `.is('artwork_url', null)` so a parallel call can't clobber another's write, and
  caches an empty string for "IGDB has nothing" so it isn't asked again.

Its own numbers, for the record:

- **46 of 91,815 rows filled (0.05%)** at the time this was first measured — exactly
  the 46 games that appear in a `posts` row. Filled on demand, not seeded for the
  whole catalog.
- URLs use `t_screenshot_huge` — measured at **1280×720, 126 KB**. Same
  fixed-16:9-centre-crop family as `t_screenshot_big` (§3c), just twice the weight.
  For a card that appears on a long press, 940×529 at ~30–80 KB is still the better
  pick if this is ever revisited for the quick-view card specifically.

Two consequences that made this worth declaring even though the function turned out
to be planned work rather than a mystery:

1. `npm run db:reset` would have produced a database the live app's feed cannot use.
2. A `create or replace function shelf_feed(...)` written from this repo's old copy
   would have silently deleted the 28 columns above, with no error on either side.

This is the fifth time work that happened outside this repo's normal commit-and-push
flow has been found asserting something untrue about the live system — not because
the work itself was wrong, but because nothing here recorded that it existed.
**When work is built this way again — deployed straight from a session without a
local file, however legitimate — commit the source here in the same session, not
later.** That's the actual fix; the schema/function declaration this section
describes is the cleanup, not the prevention.

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

## 5. Build order — all done

| # | Work | Size | Status |
|---|---|---|---|
| 1 | Return `summary` on `CatalogGame` (§2d) | half a day | **SHIPPED 18 Sep night** |
| 1b | Fix `_shared/games-by-ids.ts`'s own gap (§2e) | one line | **SHIPPED 18 Sep night** |
| 2 | Blurred-cover background, app-side | zero backend | Already shipped in the app before this feature started |
| 3 | Reconcile the migrations with the live schema (§3e) | bigger than estimated | **SHIPPED 18 Sep night** |
| ~~4~~ | ~~Fill `artwork_url` from IGDB screenshots~~ | — | **CANCELLED for this feature** — blurred cover already live; `game-artwork` already does this, built in an earlier session, now declared (§3e) |
| ~~5~~ | ~~Model-written blurbs~~ | — | **DECLINED 18 Sep** |

**The whole quick-view backend is items 1 and 1b.** Item 2 was already shipped in
the app. Item 3 was unrelated housekeeping this session happened to uncover, bigger
than expected, and worth its own read (§3e).

## 6. Decisions — all closed 18 Sep

| Question | Answer |
|---|---|
| Blurred cover or real key art? | **Blurred cover.** Already live in the app. |
| Raw IGDB paragraph, clamped by the app? | **Yes.** §2c option A, shipped. |
| ~$5 for model-written blurbs? | **No.** |
| Video / GIF background? | **Impossible** — §4, not a budget question. |

Still owed to people, and not decided here:

- **Sola:** the whole contract — `summary` and `game-artwork` both — is
  `docs/quick-view-card-for-sola.md`. He owes the whitespace collapse before
  clamping (30.6% of summaries contain a newline), the ellipsis if he wants one, and
  the call as to whether the quick-view card calls `game-artwork` at all or ships
  with just the blurred cover.
- **Josh, two things raised that nobody has answered:**
  1. **IGDB attribution and commercial use.** The app already carries *"Game data and
     cover art from IGDB.com"* on the detail screen, which is the right instinct —
     IGDB asks for credit. But secondary sources also state the API is free **for
     non-commercial use**, with commercial projects directed to a partnership.
     Prysm is going paid ($4.99 / $29.99). **Still unverified against the primary
     source** — `api-docs.igdb.com` and `igdb.com/api` both return 403 to an
     automated fetch (Cloudflare), so this needs a human with a browser reading the
     actual terms. Flag, not a finding. The credit line should probably also mention
     descriptions now that §2d has shipped, since the app is now displaying IGDB
     prose, not just data and covers.
  2. **Time-to-beat sample size** — see §7. The ordering bug is fixed; the sample-size
     question is Paul's wording call, not a build.

---

## 7. Side finding: `ttb_*` carried values that were visibly wrong — SHIPPED 18 Sep, confirmed applied

**Status: guard written, backfill written, verification written and passing in
full, including the live catalog check. Confirmed already applied before the
shipping session on 18 Sep night started — `npm run verify:ttb` passes both
sections clean, and Vice City's `ttb_*` columns are null in the live database, not
135h.**

- `_shared/mapping.ts` — `guardTtbOrder()`, applied inside `mapIgdbGame`, so future
  seeds are clean.
- `supabase/migrations/20260918110000_ttb_monotonicity.sql` — cleared the 153 rows
  already written, and recomputed `session_fit` for the 5 rows whose value came from
  the time-to-beat branch.
- `scripts/verify-ttb.ts` (`npm run verify:ttb`) — 15/15 mapper checks pass; the
  catalog half also passes clean (no "153 left"), confirming the migration landed.

Not part of the original brief. Spotted on the screenshot the user sent to settle the
background question — the live detail screen for **Grand Theft Auto: Vice City** read
**"135h to beat"**. Vice City is a ~30-hour game.

The stored row, queried 18 Sep daytime, before the fix:

| column | value |
|---|---|
| `ttb_hastily_hours` | **876.0** |
| `ttb_normally_hours` | 134.6 |
| `ttb_completely_hours` | 181.8 |
| `ttb_count` | 13 |
| `session_fit` | `high` |

**`hastily` is larger than `completely`.** That is not a plausible reading of any
game; it is corrupt crowd data that the existing guard did not catch.

`mapping.ts` already had a plausibility filter — `TTB_MAX_PLAUSIBLE_HOURS = 1000`,
added because values ≥ 10000 overflow `numeric(5,1)` and killed a whole 500-row seed
page. It was doing its job. It just only caught the *absurd* tail, not the merely
wrong: 876 < 1000, so it passed.

Scope, over the 5,106 catalog rows that had a `ttb_normally_hours` at all before the
fix:

| Check | Rows | Share of rows with a value |
|---|---:|---:|
| `hastily > normally` (internally contradictory) | 111 | 2.2% |
| `normally > completely` (internally contradictory) | 188 | 3.7% |
| `normally > 200h` | 52 | 1.0% |
| `normally > 500h` | 23 | 0.5% |
| Derived from a **single** submission | 2,947 | **57.7%** |
| Derived from ≤ 3 submissions | 4,290 | 84.0% |

Two separate problems, and the second is the bigger one:

1. **A monotonicity guard was missing.** `hastily <= normally <= completely` is a
   property the data must have. ~300 rows broke it and were demonstrably wrong; the
   fix nulls the whole triple when the ordering is violated by more than 25%, exactly
   as the 1000h guard nulls an implausible one. Vice City's 876h is caught by this.
   **Fixed and applied.**
2. **57.7% of surviving time-to-beat values come from one person's submission**, and
   84.0% from three or fewer.
   That is not a bug, it is what IGDB has — but "135h to beat" is presented to the
   user as fact, with no sample size next to it, and it feeds `session_fit` and
   `shelf_roulette`'s `size` filter. Whether to show a number backed by n=1 at all is
   a product question for Paul, not an engineering one. **Still open — this is not
   an engineering call and `ttb_count` is already on the row, waiting for a decision
   about wording, not a build.**

Deliberately kept out of the quick-view migration: this was a separate change with a
separate reason, and mixing them would have made either one hard to revert.
