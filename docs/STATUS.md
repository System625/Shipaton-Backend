# Shelf backend — where things stand

**Last updated 7 September 2026.** Ship deadline **30 Sep 2026, 11:45pm PDT**;
judging runs to **22 Oct**.

This is the pickup doc. Read it, then `docs/spec.md` for any *why* it doesn't
answer. The spec is the authority — every external claim in it was checked against
the vendor's own documentation on 4 Sep, so don't redo that research.

---

## The one-paragraph version

**The Supabase half is done and verified against the real project.** All ten
migrations are applied to `sbunhrxwhraigwpidbxk`, the normalizer matches the spec's
worked example exactly, search and roulette were exercised against seeded rows, and
RLS was confirmed to isolate two real accounts — read *and* write.

**The Twitch blocker is gone and the catalog is seeded.** 7 Sep: a Twitch account
created abroad (Nigerian numbers are still rejected by Twitch's 2FA — the workaround
was the account, not the phone) produced real IGDB credentials, and the catalog now
holds **89,117 games, 62,685 alternative titles and 161,738 platform links**. All
twelve abbreviation and hashtag cases resolve in the top 5 against real data.
`/search` on real data works.

**`/search` and `/games/:id` are deployed and verified against a real JWT** (7 Sep),
which is step 5 — the milestone the rest was building toward. `npm run verify:functions`
re-checks the deployed endpoints in one command. What remains before the app can call
them is app-side: it has no Supabase client and no session yet.

---

## Blocked right now

**Nothing on IGDB. The remaining blocker is auth provider enablement** — Apple
Developer Program membership and a Google Cloud project, both Josh's, per
`docs/auth-setup.md`. Unchanged by any of the 7 Sep work.

<details>
<summary>Resolved 7 Sep — the Twitch 2FA blocker, kept for the record</summary>

**Twitch would not accept the phone number, so there were no IGDB credentials.**

IGDB authenticates through Twitch OAuth, and Twitch will not let you register an
application without 2FA enabled. Enabling 2FA rejects Tunde's Nigerian mobile with
`INVALID_PHONE_NUMBER` — the number is correctly formatted (`+234 816 095 5592`,
a valid MTN line, 10-digit national number), so this is Twitch's validation, not a
typo.

There is no authenticator-app route around it. Twitch's own 2FA article, verbatim:

> SMS verification is always required first, even if you plan to use an
> authenticator app.

Twitch's 2FA phone layer is Authy, which is why the rejection is unlikely to yield
to retrying the same form.

**The fix: have Josh register the Twitch app and send over the Client ID and
Secret.** IGDB never sees whose account produced them — only the client id. Josh
owns the business side and sent the partnership email, so if IGDB approves and ties
the partnership to a client id, that is arguably where the app belonged anyway.

Cheaper things worth 5 minutes first: the separate **Contact → "Add a number"**
flow at `twitch.tv/settings/security` (a different endpoint from the 2FA modal);
waiting out a possible rate limit; a different Nigerian carrier. Not a VoIP number —
Twitch rejects those explicitly.

**Resolution.** Neither the alternate contact flow nor a different carrier worked.
Tunde's brother, who is abroad, created the account; it registered the app
`Prysm Blast Catalog` (Confidential client, `http://localhost` redirect) and the
credentials went straight into `.env`. Josh never had to do it.

**One consequence to track.** STATUS previously planned for *Josh* to register this
app, because IGDB ties an approved commercial partnership to a client id and Josh
sent the partnership email. The partnership request and the client id now trace to
different people. IGDB only ever sees the client id so nothing breaks, but if IGDB
replies, Josh needs to know which client id to name — and per the Twitch agreement,
if that developer account is ever closed, the stored catalog goes with it.

</details>

**Ask Josh for the auth credentials in the same message.** Social sign-in is now
decided (see Open decisions), which needs an Apple Developer Program membership and a
Google Cloud project — both store/platform accounts, both Josh's, so this is the
*same* dependency shape as Twitch. Asking now rather than after the seed avoids
waiting on him twice in sequence; with the deadline on 30 Sep, serialized waits are
the expensive kind. **The ask is smaller than it looks** — for iOS-native Apple
sign-in, membership is the whole Apple requirement, no `.p8` or Services ID. See
`docs/auth-setup.md` for the exact list and why.

---

## What is built

Ten migrations in `supabase/migrations/`, applied in filename order — **all of
them applied to the real project**, with the recorded history repaired to match
these filenames so `db push` is a no-op:

| File | What it does |
|---|---|
| `…000100_catalog.sql` | `platforms`, `games`, `game_platforms`, `search_cache` |
| `…000200_user_data.sql` | `library_entries`, `share_intake` |
| `…000300_rls.sql` | catalog readable by `authenticated`, user data owner-only |
| `…000400_matching.sql` | `shelf_match_title()` + a trigger that keeps it current |
| `…000500_search_and_roulette.sql` | `shelf_search_games()`, `shelf_roulette()` |
| `…000600_match_title_apostrophes.sql` | apostrophes dropped, not spaced — see step 3 |
| `…000700_revoke_anon_execute.sql` | actually revokes `anon` EXECUTE; 000500 did not |
| `…000800_fk_indexes.sql` | covering indexes for three unindexed foreign keys |
| `…000900_alt_titles.sql` | `game_alt_titles` + abbreviation-aware `shelf_search_games()` |
| `…001000_alt_title_noise.sql` | drops alt titles normalizing to under 2 chars (CJK, Cyrillic) |

Three decisions in there worth knowing before you edit any of it:

- **Title normalization is a database function, not TypeScript.** `shelf_match_title()`
  is the single implementation, and a trigger on `games` applies it on every insert
  and title update. The seed, `/search` and share matching all route through it, so
  catalog titles and incoming query text cannot drift apart. If they drift, matching
  silently degrades and nothing errors — that is why it lives in one place.
- **`shelf_roulette()` checks `auth.uid()` itself** rather than trusting RLS to stay
  in place. Belt and braces on the one function that reads another table's rows.
- **`pg_trgm` and `unaccent` install into the `extensions` schema**, not `public`,
  and every function sets its search path accordingly.

`supabase/functions/_shared/` holds modules with **no Deno or Node globals**, so the
edge functions and the seed scripts share one implementation of everything:

| File | What it holds |
|---|---|
| `igdb.ts` | token cache (reads `expires_in`), 4 req/sec throttle, 429 backoff, Apicalypse query builders, cover URL construction |
| `mapping.ts` | IGDB row → catalog row. Seconds→hours, unix→date, the `pcRequirements` that does not exist |
| `ingest.ts` | the write path: upserts and the on-miss IGDB lookup. Needs a service-role client |
| `session-fit.ts` | the genre/keyword heuristic behind the roulette's session question |
| `catalog-game.ts` | the `CatalogGame` contract the app consumes, plus `abbreviation` and `colorKey` |
| `oembed.ts` | provider detection, oEmbed fetch, YouTube title cleaning, TikTok hashtag extraction |
| `http.ts` | CORS, JSON responses, per-request auth (builds the client with the caller's JWT so RLS applies) |

Five edge functions, one per directory: `search`, `games`, `share-resolve`,
`share-confirm`, `roulette`.

Scripts in `scripts/`, all Node + tsx (**not** Deno):

- `verify-igdb.ts` — token, real query, `game_type` filter, seconds→hours, in one pass
- `seed-platforms.ts` — must run before games; platform links FK to it
- `seed-games.ts` — resumable, prints `SEED_RESUME_AFTER_ID` each page
- `smoke-oembed.ts` — local oEmbed baseline
- `verify-auth-rls.ts` — two real signed-in users, 18 RLS and token checks, self-cleaning

Also done: docs moved out of `~/Downloads` into `docs/`, Supabase MCP server added
at project scope in `.mcp.json`, `.env` pre-filled with the project ref and URL.

### Bugs already found and fixed

The first two were found by running the extraction code rather than reading it; the
three in step 3 were found the same way, by running the SQL against a real Postgres
rather than reviewing it:

1. The YouTube title cleaner dropped everything after a colon — "Hollow Knight:
   Silksong – Announcement Trailer" became "Hollow Knight". Now keeps every segment
   before the first noisy one.
2. All-lowercase hashtags like `#eldenring` cannot be word-split without a
   dictionary. Left as-is deliberately: pg_trgm scores "eldenring" against
   "elden ring" at ~0.62, above the 0.55 confident threshold. There is a comment in
   `oembed.ts` explaining the arithmetic so nobody "fixes" it later.

---

## What to do next, in order

### 1. Authenticate the Supabase MCP server — **DONE**

### 2. Fill in `.env` — **DONE except Twitch**

`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` are all set and
**verified against the live project over HTTP**: the service-role key reads the
catalog with RLS bypassed, the anon key is correctly blocked and returns `[]`. Only
the two Twitch values are outstanding, and they wait on the blocker above.

`DATABASE_URL` is set, but note that **nothing in the repo reads it** — the old
comment calling it "used by the seed script for bulk COPY-style inserts" was wrong.
No code opens a direct Postgres connection; the seed writes through PostgREST with
the service-role key (`scripts/supabase-admin.ts`). Harmless to keep for psql access,
just don't expect it to be load-bearing.

### 3. Push the schema — **DONE, and it surfaced things**

All ten migrations are applied and the recorded migration history was repaired to
match the filenames exactly, so `npx supabase db push` is now a clean no-op rather
than an attempt to re-run everything. Applied through MCP; the CLI was never
`supabase login`-ed, which is why the versions needed repairing at all.

The DDL itself applied without a single error — the "expect this step to surface
something" warning was right, but not about the SQL failing. What it surfaced:

**The normalizer had an apostrophe bug** (fixed, migration `…000600`). The
`[^a-z0-9 ]` class turned every apostrophe into a space, so "Baldur's Gate 3"
normalized to `baldur s gate 3` with a stranded "s". The typed case survived it
(0.72, still confident), but the **run-together hashtag path did not** — and that
is the path share ingestion depends on:

| catalog | typed | before | after |
|---|---|---|---|
| No Man's Sky | `nomanssky` | 0.294 | 0.375 |
| Garry's Mod | `garrysmod` | 0.467 | 0.615 |
| Dragon's Dogma 2 | `dragonsdogma2` | 0.429 | 0.526 |
| Baldur's Gate 3 | `baldurs gate 3` | 0.722 | 1.000 |

At 0.294 "No Man's Sky" was not merely ranked low, it was **invisible**: `%` filters
at `pg_trgm.similarity_threshold` (0.30), so the row never came back at all. Every
measured case improved, none regressed.

**`anon` had EXECUTE on the functions** despite migration `…000500` trying to revoke
it (fixed, migration `…000700`). `revoke ... from public` only drops the implicit
PUBLIC grant; Supabase's default privileges also add an *explicit* `anon=X` grant,
which the revoke slid straight past. Nothing was exposed — both functions are
SECURITY INVOKER, so anon hit RLS and got zero rows — but the migration's comment
claimed a property the catalog did not have.

**Three foreign keys had no covering index** (fixed, migration `…000800`), all on
the small per-user tables. The one that mattered is `library_entries.game_id`:
without it every catalog re-seed forces a sequential scan to check the reference.

Verified while the test rows were in place, then cleaned up:

- `shelf_match_title` — 22/22 cases, including the spec's own worked example
  (`The Witcher III: Wild Hunt - Game of the Year Edition` → `the witcher 3 wild
  hunt`), the U+2019 typographic apostrophe, and `Director's Cut`.
- The documented `#eldenring` arithmetic in `oembed.ts` **checks out at 0.615**.
- `/search` ranking: exact titles 1.00, `cyberpunk` → Cyberpunk 2077 at 0.67,
  `witcher 3` → 0.45 (plausible, not confident — see thresholds below).
- `shelf_roulette` returns rows under a real JWT, ranks a `playing` game above
  `backlog` on a short evening, and **never came back empty** for a big-RPG backlog
  at any session length from 0.5h to 8h — the exact trap it exists to prevent.
- **RLS isolates two real accounts.** B could not read A's rows, could not write to
  them (0 rows affected), and calling `shelf_roulette` with A's uuid returned
  nothing. `anon` sees 0 rows across all five tables and now has EXECUTE on nothing.

### 3b. Abbreviations — **DONE**

`bg3`, `gta v`, `gta5` and `zelda botw` used to return **nothing** — not a low score,
nothing. Trigram similarity shares almost no trigrams between an abbreviation and a
full title, so `%` filtered them out before ranking ran. Fixed in `…000900`, which
adds `game_alt_titles` fed from IGDB's `alternative_names`.

> **Read the numbers below carefully — they were measured against hand-written rows,
> not IGDB data.** No IGDB call has ever been made (see the blocker: no Twitch
> credentials). The alternative titles used in this test were typed from memory, so
> the table shows the *ranking mechanism* working end to end. It does **not** show
> that IGDB supplies an acronym for any particular game. **Coverage is unmeasured
> and is the first thing to check during the seed.**

| query | before | after |
|---|---|---|
| `bg3` | nothing | Baldur's Gate 3 (0.98) |
| `gta v` | nothing | Grand Theft Auto V (0.98) |
| `gta5` | nothing | Grand Theft Auto V (0.37) |
| `zelda botw` | nothing | Breath of the Wild (0.98) |
| `cp2077` | nothing | Cyberpunk 2077 (0.98) |
| `tw3` | nothing | The Witcher 3 (0.98) |
| `witcher 3` | 0.45 | 0.70 — crossed into "confident" |

Nothing regressed: `elden ring` 1.00, `#eldenring` 0.62, the GOTY round trip 1.00.

**What IS verified about IGDB**, from its own published type definitions rather than
recollection: `Game.alternative_names` exists, `AlternativeName.name` is optional
(so it can be missing, and the mapper guards for it), and `AlternativeName.comment`
is documented as *"A description of what kind of alternative name it is (Acronym,
Working title, Japanese title etc)"* — so Acronym is a real category, not a guess.
What is **not** verified is how many games actually carry one.

**That same field carries CJK and Cyrillic**, which `shelf_match_title` reduces to
junk, because it strips everything outside `[a-z0-9 ]`:

| alternative title | normalizes to |
|---|---|
| `ゼルダの伝説 ブレス オブ ザ ワイルド` | `` (empty) |
| `Ведьмак 3: Дикая Охота` | `3` |
| `巫师3：狂猎` | `3` |
| `BG3` | `bg3` |

Migration `…001000` drops anything normalizing to under two characters, at write
time, in the trigger. The empty rows could never match; the `3` rows were worse —
real trigram index entries that would attach short numeric queries to whichever game
happened to have a Russian title. Two characters is the floor because real acronyms
go that short ("ER"). Verified: 9 rows in, 4 kept, junk dropped silently without
failing the insert — which matters because one bad alternative title must not kill a
500-row seed page.

**A child table, not a `text[]` on `games`, and that choice is load-bearing.**
pg_trgm cannot index array elements, so an array would only support exact `@>`
matching. That fixes `bg3` but still misses `gta5` (alt "GTA V" normalizes to
`gta 5` — close, not equal) and `zelda botw` (an extra word). Fuzzy needs a real
trigram index, and a trigram index needs a row per title.

Three things about it worth knowing before editing:

- **Keyed on the normalized title**, not the raw one. IGDB lists several spellings
  that normalize identically — "GTA V", "GTA 5" and "Grand Theft Auto 5" collapse to
  two rows, not three. Verified that the collision is handled *within a single
  insert*, which is exactly what PostgREST sends during the seed: `on conflict do
  nothing` resolves it silently rather than erroring.
- **Alt matches are scaled by 0.98** so a canonical-title match outranks an
  alternative-title match of equal raw similarity. It only ever breaks ties between
  *different* games; a game matching on both keeps the higher score.
- **Alt-title writes are warn-only** in both the seed and `ingest.ts`, like platform
  links. A game with no alt titles is fine; losing them costs a few fuzzy matches,
  not the catalog row.

Confirmed working under a real `authenticated` JWT, not just as superuser — the
function is SECURITY INVOKER, so a missing policy on `game_alt_titles` would have
made abbreviation search fail silently for real users while passing every test run
as `postgres`.

### 4. Seed the catalog — **DONE 7 Sep**

```sh
npm run verify:igdb      # do this first; fails in 2s instead of mid-seed
npm run seed:platforms   # must precede games
npm run seed:games       # two passes, each independently resumable
```

**Result: 89,117 games, 62,685 alternative titles, 161,738 platform links, 98 MB.**
220 platforms. Zero warnings, zero rows with `igdb_game_type <> 0` — the edition and
DLC filtering held across 89k real rows.

**The seed grew a second pass, because the first one was building the wrong
catalog.** Spec §2 says "everything from the last 3 years, **plus anything popular
enough to matter**". Only the date arm was ever implemented; `SEED_MIN_POPULARITY`
sat in `.env` read by nothing. A date-only seed contains **none** of Elden Ring (Feb
2022, misses by ten months), The Witcher 3, GTA V, Cyberpunk 2077, BotW, RDR2,
Hollow Knight or Stardew Valley — every worked example in this doc and the spec.
That is the wrong half of the library for an app about the backlog you already own:
a backlog is accumulated, so it skews old. `seedPopularPageQuery` adds pre-2023
games with `total_rating_count >= 5` — 13,558 rows, +18%, under a minute.

**Alternative-title coverage — the open question from §3b, now measured.**

| | |
|---|---|
| games with at least one alt title | **49,175 / 89,117 = 55.2%** |
| abbreviation cases resolving in top 5 | **12 / 12** (8 at rank 1) |

`bg3`, `gta v`, `gta5`, `botw`, `rdr2`, `eldenring`, `nomanssky`, `garrysmod`,
`witcher 3` all rank first. IGDB's acronym data is good. **The hand-curated alias
fallback this section used to propose is not needed** — don't build it.

**Time-to-beat coverage is 5.1%** (4,523 of 89,117) and that is not a seed defect:
only 7,534 entries in all of IGDB carry a `normally` value, so we hold ~60% of every
time-to-beat that exists. `deriveSessionFit` falls back to genres and keywords, so
roulette works without it — but do not treat `ttb_*_hours` as reliably present.

**A corrupt row killed the first run**, and the fix is worth knowing about. "Where
Winds Meet" reports 25,107 hours to beat normally off 7 submissions; `ttb_*_hours`
is `numeric(5,1)`, so anything >= 10000 fails the insert and takes the whole 500-row
page with it. `mapping.ts` now nulls anything above `TTB_MAX_PLAUSIBLE_HOURS`
(1000h). Null, not a wider column: a 25,107h reading would make roulette rank a game
as fitting no session ever, on one bad submission, while null is a state the
pipeline already handles for the 95% of games with no entry at all.

The 1000h line is a judgement call and the data supports it. Immediately below it
sit endless live-service games with real submissions — Minecraft 955h, Fallout 76
877h, Warframe 847h, and round 1000h entries for Mobile Legends and Crossy Road.
Above it, corruption. Tune the constant in `mapping.ts`; nothing else reads it.

> **If you re-seed, re-run both passes from zero rather than resuming.** The first
> run wrote 4,500 rows before the crash and the resume never revisited them, which
> left 6 rows the fixed mapping would never produce. Resume is for interruptions,
> not for code changes.

### 4b. Search ranking has no popularity signal — **OPEN, decide before demo**

Measured against the seeded catalog, `cyberpunk` returns **Cyberpunk SFX** and
**Cyberpunk Sex** above **Cyberpunk 2077**. `zelda botw` lands 4th, `dragonsdogma2`
sits behind `Dragon's Dogma`. Nothing is unfindable — all 12 test cases are in the
top 5 — but the most-wanted result is not always first, on the app's primary path.

Cause: `shelf_search_games` ranks on trigram similarity alone, and similarity favours
**short** titles. A three-word shovelware title beats a famous game whose name is
longer than the query. No amount of alt-title work fixes this; it is a ranking
problem, not a matching one.

Fix, when someone picks it up: store IGDB's `total_rating_count` and use it as a
tie-break among rows of comparable similarity. The seed already filters on the field
in pass 2 (`seedPopularPageQuery`) without storing it, so this is a migration plus a
re-seed, not new API work. Deliberately **not** done on 7 Sep — it changes ranking
semantics and wants a decision, not a drive-by.

### 5. `/search` and `/games/:id` live — **DONE 7 Sep**

Both are deployed to `sbunhrxwhraigwpidbxk` and verified against a real signed JWT.
`share-resolve`, `share-confirm` and `roulette` are deliberately **not** deployed;
they are steps 7 and 8 and nothing has exercised them yet.

```sh
npm run verify:functions   # 29 checks against the DEPLOYED urls, not localhost
```

`scripts/verify-functions.ts` creates its own user, signs in, and walks the whole
deployed path: GoTrue issues a token, the edge runtime verifies it, `http.ts` rebuilds
a client from it, RLS applies, and the response comes back through `toCatalogGame`. It
pins the response *shape* too, so a future palette or field drift fails loudly instead
of silently rendering grey. All 29 pass, including `elden ring` at **rank 1**.

`TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET` are set as function secrets — `/search`
needs them for the live-IGDB fallback when the local catalog scores below 0.55. The
`SUPABASE_*` vars are injected by the platform and must not be set by hand.

**The base URL is `https://sbunhrxwhraigwpidbxk.supabase.co/functions/v1`.**

**Steps 1–5 are the whole current app on real data, and are independent of
everything below. That point is now reached.**

#### The app-side seam is bigger than "swap two functions"

Checked against the app repo (`akintewe/revenue-cat-game`) on 7 Sep, and this doc
previously understated it. Two things:

**The app has no Supabase wiring at all** — no `@supabase/supabase-js` in
`package.json`, no reference to `supabase` anywhere in `src/`, and `src/config/env.ts`
carries only RevenueCat keys. Both endpoints call `authenticate()` and 401 without a
JWT, so the base URL alone buys nothing: the app needs a client and a session first.

**`CatalogGame` means different things on each side.** `src/data/catalog.ts` is a mock
("standing in for a real games database until that integration is wired up") shaped
around 19 hand-typed rows where every game has exactly one platform and one genre.
Rule applied when reconciling them: **the backend owns anything derived from IGDB
data; the app owns anything that is a design decision.**

| Field | Winner | Why |
| --- | --- | --- |
| `platforms[]` vs `platform` | backend | Elden Ring returns 6 platforms. One string discards the 161,738 seeded links. |
| `genres[]` vs `genre` | backend | IGDB returns arrays. |
| `releaseDate` vs `year` | backend | `year` is required in the app's type but undated games exist, so it is unsatisfiable. App derives the year. |
| `id` uuid vs slug | backend | `library_entries.game_id` FKs to `games.id`; the app cannot write with `'elden-ring'`. |
| `abbreviation` | backend | Cannot hand-type 89k. |
| `colorKey` | **app** | Real design values in the app's `theme.ts`. The backend's were an unverified placeholder. |
| `pcRequirements` | neither | IGDB has no such field. `GameDetailScreen` renders it from hand-written strings; that section needs dropping or another source. |

**The palette was a live defect, now fixed.** The backend emitted `amber, rose,
violet, indigo, teal, emerald, slate`; the app knows `teal, orange, purple, pink,
gold, navy, red, green, blue, slate`. Only two overlapped, and `GameCover.tsx`
resolves an unknown key as `coverColors[colorKey] ?? coverColors.slate` — so five of
seven keys rendered as the same grey with no error on either side. `COVER_COLOR_KEYS`
now matches the app exactly and `verify:functions` asserts it.

**Two things still want Sola, not a decision here.** `releaseDate` presence currently
*means* "unreleased" in the app (it gates `scheduleReleaseReminder`); the backend sends
it for every dated game, so the app should compute `isUnreleased = releaseDate > today`
rather than keep presence-as-a-flag. Nothing breaks meanwhile — `scheduleReleaseReminder`
no-ops on past dates. And `deriveAbbreviation` returns up to three initials, so
*Return of the Obra Dinn* is `ROD` where the app's mock had `RO`; cap it at two if the
48px swatch looks wrong.

### 6. Auth — **verification DONE, providers blocked on Josh and Sola**

**Full detail is in `docs/auth-setup.md`.** Two things happened on 5 Sep:

**The real-JWT check is done.** `npm run verify:auth` runs
`scripts/verify-auth-rls.ts`, which signs two real users in and drives 18 checks
through the tokens GoTrue actually issues — including `getUser()`, the exact call
`http.ts` makes — instead of the `set_config` simulation used in step 3. All 18 pass.
It creates and removes its own users and fixtures, so it is safe to re-run, and it is
provider-agnostic: Google and Apple change who mints the identity, not the JWT shape
or how RLS reads it.

**The Apple ask to Josh is smaller than this doc previously claimed.** Services ID,
Team ID, Key ID and `.p8` are needed only for the *OAuth* flow, which for this app
means Android. Native iOS Sign in with Apple needs an App ID with the capability
enabled, registered under *Client IDs*, and nothing else — Supabase's own guide:
*"If you're building a native app only, you do not need to configure the OAuth
settings."* That also drops the 6-month secret rotation, which is worth avoiding on a
project sitting idle between 30 Sep and judging on 22 Oct. The cost is that an
account made with Apple on iOS cannot sign back in on Android; 4.8 does not bind
Android, so that is convenience, not compliance.

Config applied the same day, with the CLI now logged in: **manual identity linking
is on** (it was off, which mattered — see below), and `password_min_length` went 6 → 8.
Leaked-password protection is **Pro-only** (`HTTP 402`), so it stays off on Free.
`verify:auth` re-run after both changes: still 18/18.

**A trap that is a product bug, not a setup detail.** Supabase links a new OAuth
identity to an existing user *only when the email matches*. Apple's **Hide My Email**
issues a `@privaterelay.appleid.com` relay address, which never matches a Google
address — so one person signing in with Google and later with Apple gets **two
`auth.users` rows**, and because `library_entries` keys on `user_id`, their whole
shelf appears to vanish with no error. 4.8 requires the email-privacy option, so this
is the path Apple pushes users toward. Cheapest fix is one provider per platform
(Apple on iOS, Google on Android); that is a UI decision, so settle it before Sola
builds the sign-in screen. Detail in `docs/auth-setup.md`.

Also confirmed with the real CLI rather than MCP: `db push --dry-run` reports the
remote up to date, and `config.toml` claimed Postgres 15 while the project runs 17.6
— fixed, or the local stack would have run a different major version than production.

Still blocked: Google Cloud and Apple Developer accounts are Josh's, and the bundle
ID, Android package name, SHA-1 fingerprint and deep-link scheme are Sola's — none of
them are recorded anywhere in this repo.

Then migrate the app's Zustand store from AsyncStorage-only to synced.

### 7. Share ingestion

Deploy `/share-resolve`, then **immediately call it against a real YouTube link and
a real TikTok link from the deployed function, not from a laptop.** The oEmbed
verification on 4 Sep was done from a residential IP; a cross-check report claims
datacenter IPs get throttled or 403'd, and that half is untested. If it 403s
deployed and works locally, that is why, and the fallback is the page's OpenGraph
tags. `npm run smoke:oembed <url>` gives the local baseline to compare against.

Then collect ~20 real gaming TikTok captions and measure how often the top candidate
is right. Caption extraction is guesswork until that happens. Sola handles
`expo-share-intent` + prebuild, which is what loses Expo Go.

### 8. Roulette

Deploy and actually roll against a seeded backlog. Sanity-check the thing the
two-input split exists to prevent: a backlog of big RPGs must never come back empty
just because the session is short.

---

## Traps

These are the ones that cost time if you hit them without warning.

- **The seed is a script, not an edge function.** Free-plan functions cap at 2s CPU
  and 150s wall clock; a bulk load blows through both.
- **Filter `game_type = 0`.** Without it, "Elden Ring" returns the base game, Shadow
  of the Erdtree, the Deluxe bundle and assorted packs as separate rows, and they all
  land on the confirm screen. Single easiest way to make the share feature look
  broken. Enforced in the query *and* after it, because Apicalypse `search` ignores
  some `where` clauses.
- **`critic_score` is IGDB's aggregate of external critic scores, not Metacritic.**
  Do not label it that in the UI.
- **IGDB attribution is a requirement**, not a nicety: user-facing, visible, static
  location. Part of the partnership terms.
- **`igdb_id` is a reference, not an identity.** Nothing outside `mapping.ts`,
  `ingest.ts` and the seed reads it. That rule is what kept the RAWG→IGDB switch to
  one afternoon, and it is what keeps the RAWG fallback (spec §11) a sync-layer
  change rather than a rewrite.
- **`search_cache` is referenced by no code at all.** The table exists with RLS on
  and no policy, which the Supabase linter reports as INFO. That is the correct
  locked-down posture for a table only the service role should write, so it was left
  alone — but nothing reads or writes it today. Either wire it up or drop it; don't
  assume it is doing something.
- **Free-tier Supabase pauses after 1 week of inactivity**, and judging runs to
  22 Oct. A paused backend during judging means judges open the app and it does not
  work.

---

## Open decisions

- **Free vs Pro Supabase.** Free pauses after a week idle and caps the database at
  500 MB. A third, smaller weight on the Pro side as of 5 Sep: leaked-password
  protection (HaveIBeenPwned) is Pro-only and returns `HTTP 402` on Free. Not worth
  upgrading for on its own — it guards the email/password fallback, not the real
  sign-in path — but turn it on if you upgrade for the pause problem. The seed is estimated at 100–150 MB with the trigram index, which fits but
  without headroom. **That estimate is arithmetic and has never been measured** —
  take the real number after the seed and decide on it. Budget $25/month for October
  if it is close.
- **Auth method — DECIDED 5 Sep: social sign-in.** What is still open is *which*
  providers and who supplies the credentials.

  **Apple guideline 4.8 does not say what it is usually quoted as saying.** It never
  names Sign in with Apple. Verbatim: an app using a third-party or social login
  "must also offer as an equivalent option another login service" that (a) limits
  data collection to name and email, (b) "allows users to keep their email address
  private as part of setting up their account", and (c) does not collect in-app
  interactions for advertising without consent.

  Magic link clears (a) and (c) trivially. **It is (b) that it probably fails** — the
  user hands over their real address and nothing relays or hides it. Sign in with
  Apple is built to satisfy all three. So the safe reading is that shipping Google
  sign-in on iOS obliges Sign in with Apple too; whether a magic link alone would
  pass (b) is arguable and not worth gambling a review on before 30 Sep.

  **Worth confirming before doing any of the Apple work:** 4.8 is an *App Store
  review* rule. If nothing goes through App Store review inside the contest window —
  judging runs to 22 Oct, and distribution may be TestFlight or an Android build —
  then 4.8 does not bite yet, and Apple sign-in could be deferred past the deadline.
  Ask Josh what the iOS distribution path actually is; the answer decides whether
  this is urgent or not.

  What each provider needs — **corrected 5 Sep against Supabase's own auth guides**;
  the row that changed is Apple's. Full reasoning in `docs/auth-setup.md`.

  | Provider | Needed | Whose account |
  |---|---|---|
  | Google | OAuth client IDs — iOS, Android and Web, all three registered with Supabase, web first. No client secret on the native path | Google Cloud project — Josh's |
  | Apple (iOS native) | Developer Program membership, and an App ID with the Sign in with Apple capability. **That is all** | Josh's, per "store accounts are Josh's" |
  | Apple (Android, optional) | The above plus Services ID, Team ID, Key ID, `.p8` — and a secret regenerated every 6 months | Josh's |

  The bundle ID, Android package name and Android SHA-1 signing fingerprint are
  **Sola's**, not Josh's, and are recorded nowhere in this repo. Google's Android
  client cannot be created without the fingerprint, so that ask has to go out too.

  The earlier line here said Apple needed the Services ID and `.p8` outright. It does
  not, for a native iOS app: *"If you're building a native app only, you do not need
  to configure the OAuth settings."* Taking the native-only route also avoids Apple's
  6-month secret rotation, which is a real hazard on a project that sits idle between
  30 Sep and judging on 22 Oct. The price is that Apple sign-in does not work on
  Android — 4.8 does not bind Android, so that is convenience, not compliance.

  Deep-link redirect URLs are needed either way, and the Expo cost is already sunk
  since Expo Go went for `expo-share-intent`.

- **`CoverColorKey`** in `_shared/catalog-game.ts` is a placeholder set of seven
  names. Confirm the real union against Sola's app and replace it, or the coloured
  swatch fallback renders wrong.
- **pg_trgm thresholds** (0.55 confident, 0.30 plausible) are a starting point, not a
  result. Tune against real queries. First real data point: `witcher 3` scores 0.45
  against "The Witcher 3: Wild Hunt" — a very common way to type it, landing in
  "plausible" rather than "confident". Partial-title queries generally score lower
  than feels right, because trigram similarity penalises the missing words. Worth
  revisiting once the catalog is seeded and the scores are measured at scale rather
  than against eight rows.
  Note `witcher 3` already moved 0.45 → 0.70 once alternative titles landed, so
  re-measure after the seed rather than tuning against the old numbers.

## Settled, do not reopen

- **All seven of Josh's decisions**, approved 4 Sep: IGDB over RAWG, Supabase, the
  scope cut to share / roulette / finish card, the game model redesign, confirm
  before adding a shared game, dropping Expo Go, and the two-input roulette.
- **The IGDB partnership email** to `partner@igdb.com` — sent, confirmed 5 Sep. No
  published turnaround, so assume no reply inside the contest window. Nothing waits
  on it.
- **There is no fallback provider.** Giant Bomb's API is offline, MobyGames is paid
  from ~$100/mo, RAWG is $149/mo with worse data. Researched properly on 4 Sep;
  spec §11 has the detail.
- **Google Play is not tracked in this repo.** Store accounts are Josh's. The
  12-tester arithmetic is in the spec if anyone needs it.

---

## Where the reasoning lives

- `docs/spec.md` — **read this before changing anything.** §1 IGDB vs RAWG, §3 schema,
  §4 field mapping, §5 title matching, §6 share ingestion, §7 the roulette problem
  and its resolution, §11 what happens if IGDB says no.
- `docs/auth-setup.md` — what `verify:auth` proves, and the provider runbook for the
  moment Josh's and Sola's values arrive.
- `docs/decisions-for-josh.md` — the seven decisions, all approved.
- `docs/technical-notes-for-sola.md` — what changes under the app scaffolding.
- `docs/research/` — the verification prompt and three independent cross-check
  reports. The Gemini one is memory-only with a March 2026 cutoff and is wrong on
  several points; weigh accordingly.
