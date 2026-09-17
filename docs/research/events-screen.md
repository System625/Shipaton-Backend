# The Events screen

Measured, decided, built, reviewed and verified on 17 September 2026. This replaces
the running research draft of the same name — that doc accumulated three layers of
inline corrections as the build overtook it, and the corrections mattered more than
the draft. Everything below is what is true of the live project now.

- **Sola's scoping note** (15 Sep, reached this repo as `task.md`): three candidates
  for the sidebar's "coming soon" Events entry, framed as blocked on Paul.
- **Outcome:** two of the three shipped the same day. Nothing was routed to Paul.
- **The app contract** is `docs/technical-notes-for-sola.md` §13–14. This document is
  the reasoning and the evidence; that one is what Sola builds against.

---

## 1. The measurement that reversed the lean

Sola's note leaned **Release-Day Tracker** as cheapest: *"release_date — already on
every CatalogGame"*, one small join table, done. That claim is literally true and it
does not mean what it needs to mean.

```
total games                     91,806
release_date IS NULL                 2
release_date > today             3,748   <- the whole "upcoming" universe
```

Three things make that column unusable as a day-of promise.

### 1a. Most upcoming dates are placeholders

IGDB encodes "sometime in 2027" as a real `date` — 31 Dec, 30 Sep — and flags it
nowhere on the game row. Measured from date patterns first (80.4%), then confirmed
against IGDB's own precision field after the backfill:

| Upcoming rows | day | month | quarter | year | unresolved |
|--------------:|----:|------:|--------:|-----:|-----------:|
| 3,748 | 617 | 159 | 876 | 2,086 | 10 |

**83.5% of upcoming releases are not day-precise.** 2,367 games currently claim to
launch on 31 December 2026. A "Release-**Day** Tracker" built on that notifies four
games in five on a day the publisher never announced.

### 1b. `release_tbd` does not catch it

`release_tbd` is true on **2 rows in the whole catalog** and **0 of the 3,748
upcoming**. It is `!first_release_date` in the mapper — correct for what it checks,
which is "IGDB gave no date at all", a much narrower thing than "the date is vague".
Not wired wrong; just not the safeguard its name suggests. Left as-is, documented.

### 1c. Nothing upcoming can be ranked

```
upcoming, total_rating_count = 0:      3,748   <- all of them
upcoming, critic_score IS NOT NULL:        1
```

**Structural, not a backfill gap:** IGDB user ratings accrue after release, so an
unreleased game has none by definition. `/games/popular` orders by
`total_rating_count desc`; against upcoming rows that ordering is a no-op. A
date-sorted browse of everything releasing soon therefore opens on shovelware and
NSFW-adjacent titles — same root cause as Paul's release-date filter returning 73k
rows of junk for "2020s", arriving through a different door.

### 1d. Meanwhile, Seasonal Challenge's data was already sitting there

- `library_entries.finished_at` has existed since the first migration, and the app
  already writes it on `beaten` (`useLibraryStore.ts:107`) — it just can't read it
  back (`LIBRARY_COLUMNS` omits it).
- `games.genres` is populated on 95.4% of the catalog.

So "beat 3 RPGs in October" is one `count(*)` over data that exists. Two cautions
that carried into the build: `Indie` matches 51,512 games (56% of the catalog), so
genre-only criteria can be no filter at all; and the live data disagreed with itself
— 19 library rows, **0 `beaten`, 2 carrying a `finished_at`**.

---

## 2. The decision

**Taken 17 Sep by Josh in session, deliberately not routed to Paul.** Sola framed it
as a product decision; it was taken internally on the strength of the measurement, so
nothing is owed to Paul before building.

| | Verdict |
|---|---|
| **Seasonal Challenge** | **Build first.** Data already exists. Team-authored, hand-written per season — no creation UI, no admin endpoint, no moderation surface. Answers "who authors a challenge" for season one, reversibly. |
| **Release-Day Tracker** | **Build second, in full** — cheapest schema, most expensive data. The date fix goes first; reversed, it gets built twice. |
| **Community Meetup** | **Parked.** The only one of the three that lets users publish content other users read (`location text`). That safety call shouldn't ride along inside an Events sprint. |

**Ordering was load-bearing**, and it held: the precision column is the only reason
the release sweep can tell an announcement from a placeholder.

---

## 3. What shipped

Seven migrations, two edge-function changes, one new function, two verify suites.

### Session A — Seasonal Challenge + the date fix

**`20260917100000_release_precision.sql`**

`games.release_precision text check (in ('day','month','quarter','year'))`, derived
from IGDB's `date_format` on the `release_dates` row matching `first_release_date`.

> **The plan was wrong about the source field, and checking it live is what caught
> that.** The research draft said the value came from `release_dates.category` and
> that the seed "already fetches and discards it". IGDB's current API has no
> `category` field — the name is stale — and the seed was fetching nothing from
> `release_dates` at all. IGDB accepts an unknown *sub*-field in a query without
> erroring, so a caller using `category` would have got `undefined` on every row and
> never noticed.

Backfilled the whole catalog (`npm run backfill:release-precision`):

```
91,804 dated games -> 86,194 day · 3,141 year · 1,439 quarter · 1,007 month · 23 unresolved
```

**`20260917110000_seasonal_challenges.sql`**

- `seasonal_challenges` — title, description, window, `criteria jsonb`, RLS readable
  by any signed-in user, **no insert/update/delete policy at all**: "team-authored"
  made physical. A season is `scripts/seed-challenges.ts` plus a re-run.
- `criteria` shape `{"genres": [...], "count": n}`, guarded by a CHECK.
  **A missing key evaluates to SQL NULL, not FALSE**, so `{}` passed the naive
  version of that constraint — the `?` existence tests came first after review. Same
  family of mistake as `release_tbd`: an absent value read as "checked and fine".
- **`status = 'beaten'` settled as the source of truth**, `finished_at` as the
  timestamp attached to it, enforced by a trigger both ways (set on `beaten`, cleared
  off it). The two disagreeing rows were reconciled by clearing `finished_at` — it is
  the weaker signal, being a column the app cannot even read back.
- `shelf_challenges()` returns every challenge with a computed
  `status` (active/upcoming/ended) and the caller's `my_progress {count, target}`.

### Session B — Release-Day Tracker

**`20260917120000_game_watches.sql`** — `game_watches (user_id, game_id, created_at)`,
own-rows-only RLS, **no toggle endpoint**: the app writes it straight through
PostgREST like `wishlist_entries` and `follows`. Plus `shelf_game_watcher_count`,
SECURITY DEFINER because "own rows only" would otherwise answer 0 or 1 — safe for the
same reason `shelf_popular_with_friends` is: it takes a *game* id and returns a
count, never an identity.

**`20260917130000_game_release_notifications.sql`** — the answer to Paul's question
2 ("does watching fold into the existing notification system?") is **no**, and it
took a real migration: `actor_id` made nullable, the `kind` CHECK widened to
`game_release`, `no_self_notification` relaxed to `actor_id is null or user_id <>
actor_id`, a `game_id` column with a `game_release_has_game` guard, and the dedupe
index rebuilt to include it (so: one bell per watcher per game, ever, regardless of
how many times the sweep runs). Plus `shelf_sweep_game_releases()`, gated on
`release_precision = 'day'` **only**.

**`20260917140000_game_release_push_batch.sql`** and the same fix in
`shelf_notifications`: both inner-joined `profiles` on `actor_id`. Harmless while
every kind had an actor — and a silent, error-free disappearance of every
`game_release` row from both the bell inbox and the push queue the moment one
existed. Caught before any existed.

**`game-release-sweep`** edge function, service-role-bearer only, same posture as
`push-sweep`. Getting its first-ever real service-role call is what exposed the
project's **two live Supabase key systems** — a deployed function's own
`SUPABASE_SERVICE_ROLE_KEY` is the new-format secret key (`sb_secret_…`), not the
legacy JWT every script here uses. `push-sweep`'s identical check had been silently
unpassable since 15 Sep; nobody noticed because nothing has ever called it.

---

## 4. The review, same day

Reading both sessions back against Sola's note and the live database turned up three
gaps. All three are fixed.

### 4a. `release_precision` was returned by nothing

The column shipped, the backfill ran — and `shelf_catalog_row` never carried it, so
`/search`, `/games/:id`, `/games/popular`, `/roulette` and the rest all still handed
the app a bare `release_date`. Both stated reasons for the column live *in the app*:

- making Paul's "Upcoming" filter honest, and
- stopping the app's **on-device** reminders (`reminders.ts`) firing on 31-Dec
  placeholders — a path that never touches the backend at all.

A column the app cannot read fixes neither. Worse, `technical-notes-for-sola.md` had
already told Sola *"every CatalogGame's release_date now sits next to
releasePrecision"*, which was true of the catalog and false of the API.

**Fix — `20260917150000_catalog_release_precision.sql`:** the attribute added to the
`shelf_catalog_row` composite type and returned by all five catalog functions
(`shelf_search_games`, `shelf_popular_games`, `shelf_roulette`,
`shelf_recently_viewed`, `shelf_popular_with_friends`), plus `/games/:id`'s own column
list, plus `releasePrecision` on the `CatalogGame` type. It lands **last** in the row
because `alter type … add attribute` appends and reordering would mean dropping the
type and all three functions that return it; PostgREST serialises by name, so the
position is cosmetic. Add future catalog columns the same way.

### 4b. The Events screen had no list

Session B built the per-game half — a toggle on `/games/:id`, a notification on
release day — and nothing that returns *the games a user watches*. Sola's note
describes the screen as "a date-sorted list of upcoming releases".

The app *can* read `game_watches` through PostgREST — that is why there's no toggle
endpoint — but a watch row is only `(user_id, game_id, created_at)`, so rendering it
means joining `games` client-side, and a `games` row fetched that way has no
`abbreviation` and no `colorKey`: both are derived in `toCatalogGame()` and stored
nowhere. `GameCover.tsx` resolves a missing `colorKey` as `coverColors[colorKey] ??
coverColors.slate`, so every cover on the Events screen would have rendered the same
grey, with no error on either side. **That exact drift has already cost this project
once** (see the note in `_shared/catalog-game.ts`).

**Fix — `shelf_watched_games` behind `GET /games/watching`:** full `CatalogGame`s so
the existing game-row component renders them unchanged, plus `watchedAt` and
`watcherCount`. Ordering is the server's — upcoming first, soonest first; undated
games sort with them; already-released ones fall below, most recent first, so a watch
doesn't vanish the morning it ships.

**Deliberately not built: an "everything releasing this month" feed.** §1c is why. A
curation gate — followed franchise, wishlisted, owned platform, or a hand-maintained
flag — is an open product question, and `/games/watching` needs none of it because
the user chose every row in it.

### 4c. A missed sweep meant a permanently missed release

`release_date = current_date` exactly is correct only if the sweep runs on every
single calendar day, forever. It has never run on any: **`pg_cron` is not installed
on this project**. One missed run — an outage, or simply the day the schedule is
finally switched on — and every watcher of that day's releases is silently owed a
bell that can never arrive.

**Fix:** a 2-day trailing window, safe only because `notifications_dedupe` collapses
to `(user_id, kind, game_id)` for this kind. Two days rather than a week because the
first run after the schedule goes live notifies for everything inside the window, and
"out in the last couple of days" is still true where "out last week" reads as a bug.

### Smaller things, same pass

| | |
|---|---|
| `/games/:id` swallowed the error from its own `game_watches` read | A failed read rendered as `watching: false` — indistinguishable from "not watching", so the toggle showed off and the next tap would 23505 against a row that exists. Both errors checked now. |
| The Sola notes showed `shelf_challenges` returning camelCase | Wrong for an RPC, and contradicted that doc's own §1: PostgREST returns the row as stored and supabase-js converts nothing. Corrected to `start_date` / `end_date` / `my_progress`. |
| "21 unresolved" in the Sola notes | 23. |
| `releasePrecision`'s docstring had displaced `coverUrl`'s | Inserted between an existing doc comment and its function in `_shared/igdb.ts`. Reattached. |

---

## 5. Verified, against the live project

Everything below ran after the fixes, against the deployed functions and the real
database — not a local stack.

| Suite | Result |
|---|---|
| `npm run verify:game-watches` | **all passed** — RLS both directions, anon locked out, `watcher_count` as a true cross-user aggregate, the deployed `/games/:id` (`watching`, `watcherCount`, `releasePrecision`), the new `/games/watching` (catalog shape incl. `abbreviation`/`colorKey`, `watchedAt`, per-user isolation), the sweep's 401s, its `release_precision='day'` guard, the trailing window catching yesterday's release, idempotency on a second run, the client's inability to forge a notification, and the push batch carrying `game_release` rows |
| `npm run verify:challenges` | **all passed** — criteria CHECK (including the missing-key case), the `finished_at` trigger in both directions, per-user progress, status math, RLS and grants |
| `verify:roulette`, `verify:recently-viewed`, `verify:search-filters`, `verify:friends-popular`, `verify:functions` | **all passed** — the catalog surfaces that the composite-type change touched |
| `npm run typecheck` | clean |
| Grants re-checked after every `create or replace` | no `anon` on any of the seven functions |

Live state as of this document: 91,806 games · 1 seasonal challenge · 0 real watches ·
0 `game_release` notifications ever written (see §6.1).

---

## 6. What is still open

**1 — Nothing schedules the sweep.** `pg_cron` is not installed. Until someone wires
it by hand (the pattern is in `docs/research/push-notifications.md`; the schedule is
deliberately not in a migration, because that would put a service-role key into a
file in git), the Release-Day Tracker writes nothing, ever. **Use the new-format
secret key**, not the legacy `service_role` JWT. Same unfinished step as `push-sweep`
and `vague-search-sweep`.

**2 — Push delivery is still blocked on Josh** — APNs `.p8` and FCM service-account
JSON, which OneSignal requires and does not replace. The bell rings without it; the
push does not.

**3 — Two questions for Sola**, both in the notes doc:
- **Are the on-device release reminders live in the shipped build?** They schedule
  from `release_date` with no precision check, so today they fire on placeholder
  dates through a path that never touches the backend. `releasePrecision` is now in
  every `CatalogGame` specifically so they can be gated.
- **What is "Passport stamps"?** Named in his note as what challenges tie into. No
  such table, column, function or doc exists on the backend.

**4 — Season two is a row and a re-run**, by design. Note that "October Horror
Challenge" — Sola's own example — is **not representable yet**: IGDB files Horror
under `games.themes`, not `games.genres`, and `shelf_challenges()` matches only
genres. Widening the criteria shape is a small, deliberate change, not done on spec.

**5 — The curation gate** for any upcoming-releases *browse*, as opposed to "games I
watch", is undecided and unassigned.

**6 — Community Meetup** remains parked, and the reason is unchanged: it is the only
one of the three that lets users publish content other users read.

---

## 7. What this cost, and what it bought

The build is one day. The thing worth keeping is the shape of what went wrong twice,
in the same direction both times: **a value that exists but is never read.**
`release_tbd` populated on 2 of 91,806 rows. `hours` on roulette, inert. A dedupe
column that would have been silently dropped by an inner join. A precision column
backfilled across 91,804 rows and returned by nothing — written the same day as the
doc bullet asserting it was already reaching the app.

Each was invisible to anything that only reads the code, and obvious the moment
something asked the live system a question. The verify suites are how that question
gets asked more than once.
