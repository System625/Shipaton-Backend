# Events screen — what the data actually supports

Sola's scoping note (15 Sep 2026, "Events screen — what data would we actually show?")
lays out three candidates and leans Release-Day Tracker as cheapest. This checks each
one against the **live catalog and live user data** on 17 Sep 2026 rather than against
the schema on paper.

The headline: **the lean is backwards.** Release-Day Tracker is the cheapest *schema*
and by far the most expensive *data*. Seasonal Challenge is the one whose data is
already sitting there, written and unread.

Everything below is measured. Scripts are throwaway; the queries are reproduced so
they can be re-run.

---

## 1. The claim that decides it

> "release_date — already on every CatalogGame"

**Literally true, and it does not mean what it needs to mean.**

```
total games                     91,806
release_date IS NULL                 2
release_date > today             3,748   <- the whole "upcoming" universe
```

So yes, the column is populated. Now the three things that make it unusable as-is.

### 1a. 80.4% of upcoming release dates are placeholders

IGDB encodes "sometime in 2027" as a real `date`. It does not flag it. Counting the
end-of-period conventions (`12-31`, `09-30`, `06-30`, `03-31`) across all 3,748
upcoming rows, paged in `release_date, id` order:

| Year | Upcoming | Placeholder | Share |
|------|---------:|------------:|------:|
| 2026 | 2,998 | 2,367 | 79% |
| 2027 | 703 | 608 | 86% |
| 2028 | 34 | 31 | 91% |
| 2029–2040 | 13 | 6 | — |
| **Total** | **3,748** | **3,012** | **80.4%** |

A "Release-**Day** Tracker" whose defining promise is *notified day-of* would, for four
games in five, notify on a day the publisher never announced. 2,367 games currently
claim to launch on 31 December 2026.

### 1b. `release_tbd` does not catch this

The catalog has a `release_tbd boolean not null default false` column that exists for
exactly this purpose.

```
release_tbd = true, whole catalog:        2
release_tbd = true, among the 3,748:      0
```

**It is inert.** Zero of the 3,012 placeholder-dated games are flagged. The column
that would let the UI render "Q4 2026" instead of a fake day is not being populated by
the seed. This is the same shape as the `hours` column on roulette and the dead config
comments — a field that reads as a safeguard and isn't one.

### 1c. Nothing upcoming can be ranked

The catalog's only popularity signal is `total_rating_count` (IGDB *user rating count*).

```
upcoming, total_rating_count IS NULL:        0
upcoming, total_rating_count = 0:        3,748   <- all of them
upcoming, total_rating_count >= 1:           0
upcoming, critic_score IS NOT NULL:          1
```

This is **structural, not a backfill gap**: IGDB user ratings accrue after release, so
an unreleased game has none by definition. `/games/popular` orders by
`total_rating_count desc` — against upcoming games that ordering is a no-op and the
list falls back to insertion order.

What a date-sorted upcoming list actually returns today, soonest first:

```
2026-09-18  WomboCombo
2026-09-18  Chief Cenab: Şahmaran
2026-09-18  Toxic Yuri
2026-09-18  The Grinch 2: Saving Christmas
2026-09-18  Gyaru to Papakatsu: Yarichin Chuunen Oji no Enjoy PacoPaco Life
2026-09-18  Too Many Balls
```

591 games release in the next 30 days; 256 of those are placeholder-dated. This is the
same failure already documented for Paul's release-date *filter* — "2020s" returning
73k rows of junk — arriving through a different door. The two-pass seed took everything
released after the cutoff, which means every unreleased shovelware title on IGDB is in
here, and none of the signals that normally push them down exist yet.

**A Release-Day Tracker built on this data ships an NSFW-adjacent shovelware feed as a
flagship screen.** That is the finding.

---

## 2. What each candidate actually costs

### Release-Day Tracker — cheap schema, expensive data

The schema half is genuinely small and Sola is right about it:

```sql
create table game_watches (
  user_id    uuid not null references auth.users(id) on delete cascade,
  game_id    uuid not null references games(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, game_id)
);
create index game_watches_game on game_watches (game_id);   -- watcher_count
```
Plus RLS (own rows only), and `watcher_count` as an aggregate. Half a day.

The data half is the project:

1. **A date-precision column.** `release_precision text check (in ('day','month','quarter','year'))`,
   derived from IGDB's `release_dates.category` — which the seed already fetches and
   discards, the same way `keywords`/`game_modes` were being discarded before the
   descriptive-fields migration. Without it the UI cannot tell "18 Sep 2026" from
   "sometime in 2026", and **no notification can be honest**.
2. **A curation gate.** With no popularity signal, the only defensible filters are
   editorial or derived: followed-franchise, wishlisted, on a platform the user owns,
   or a hand-maintained "tracked" flag. "Everything releasing this month" is not a
   product.
3. **A re-sync loop.** Announced dates move constantly. Today's seed is one-shot; a
   watched game whose date slips would notify on the stale date forever.

Realistic: **3–4 days**, most of it in the seed layer, not the API.

### Seasonal Challenge — the data is already there

Sola flags the criteria shape and authorship as open. Both are real. But the part he
treats as the uncertain bit — computing progress — is the part that already works:

- `library_entries.finished_at timestamptz` has existed since the first migration.
- **The app already writes it.** `useLibraryStore.ts:107` sets `finished_at` the moment
  a game goes `beaten`. It just can't read it back — `LIBRARY_COLUMNS` in
  `remoteLibrary.ts:19` omits it (documented in technical-notes §7, still open).
- `games.genres text[]` is populated on 95.4% of the catalog (4,184 empty of 91,806).

So "beat 3 RPGs between 1 and 31 October" is a `count(*) where finished_at between $1
and $2 and genres && '{Role-playing (RPG)}'` — one RPC over data that exists.

Two cautions:

- **Genre is a blunt filter.** `Indie` matches 51,512 games — 56% of the catalog. `RPG`
  (16,083) and `Shooter` (7,146) are usable; an "Indie challenge" is "any game".
- **Live data disagrees with itself right now.** 19 library rows: 3 `playing`, 16
  `backlog`, **0 `beaten` — but 2 rows carry a `finished_at`.** Before any progress
  query ships, decide whether the source of truth is `status = 'beaten'` or
  `finished_at is not null`, because today they do not agree.
- **"Passport stamps" does not exist on the backend.** Sola says challenges tie into
  "library data we already compute for Passport stamps." There is no passport or stamp
  table, column, function or doc in this repo. That is either an app-side concept or a
  planned one — worth confirming before it's treated as a foundation.

Realistic: **2–3 days**, and unlike Release-Day none of it is data remediation.

### Community Meetup — heaviest, and Sola is right

Agreed on all counts, with one addition: it is the **only one of the three that lets
users write content other users see.** Everything user-generated in Shelf today
(posts, comments) came with a block list and a privacy line that was deliberately not
widened. An in-person `location text` authored by one user and shown to others is a
safety surface, not just a moderation one. That decision shouldn't be made as a
side-effect of picking an Events direction.

Realistic: **1.5–2 weeks** including moderation. Not a 30 Sep candidate.

---

## 3. Paul's question 2, answered concretely

> Does "watching" need its own push category, or does it fold into the existing
> notification system?

**It does not fold in.** Three hard blocks in `notifications` (20260909121000):

| Constraint | Why release-day breaks it |
|---|---|
| `actor_id uuid NOT NULL` | A release has no actor. Nobody did anything. |
| `kind text check (in ('follow','post_like','post_comment'))` | No system-event kind exists. |
| `constraint no_self_notification check (user_id <> actor_id)` | With no actor, the only candidate is the user themselves — which this forbids. |

Also: every row today is written by a `SECURITY DEFINER` trigger on a social action, and
there is **no INSERT policy on the table at all**. Release-day rows would need a new
write path regardless.

Minimum change: make `actor_id` nullable, extend the `kind` check with e.g.
`game_release`, add `game_id uuid references games(id)`, relax `no_self_notification`
to `actor_id is null or user_id <> actor_id`, and extend the dedupe index. That is a
real migration, not a delivery detail — same category as `pushed_at` (20260915160000).

**Two things that do not change no matter what Paul picks:**

- Push delivery is still blocked on Josh — APNs `.p8` and FCM service-account JSON,
  which OneSignal requires and does not replace (`push-notifications.md` §1). The
  `pg_cron` wiring is still unrun.
- **The app already schedules local release reminders on-device**
  (`src/services/notifications/reminders.ts`, cited in the notifications migration).
  Those fire without any server involvement — which means **the bad dates in §1a can
  reach users through a path that doesn't touch the backend at all.** Whatever Paul
  decides about Events, §1a is worth telling Sola about on its own.

---

## 4. Decision — taken 17 Sep 2026

Decided by Josh in session, **not routed to Paul**. Sola's note framed this as blocked on
a product decision; it was taken internally instead, so nothing is owed to Paul before
building. Recorded here so the build doesn't re-open it.

**The measurement that drove it:** Release-Day is the cheapest to build and the most
expensive to build *correctly*, and the entire gap is data we don't currently store.
So the data fix goes first and the feature follows it.

### Session A — Seasonal Challenge + the date fix

1. **Seasonal Challenge Tracker**, **team-authored, hand-written** per season. No
   creation UI, no admin endpoint, no moderation surface. This answers "who authors a
   challenge" for season one without committing to user-authored challenges, and is
   reversible.
   - Progress is a `count(*)` over `library_entries.finished_at` + `games.genres`.
   - **Settle first:** `status = 'beaten'` vs `finished_at is not null` as the source of
     truth. Today they disagree (0 `beaten`, 2 with `finished_at`).
   - **Avoid genre-only criteria that match half the catalog** — `Indie` is 56% of it.
2. **`release_precision`** from IGDB's `release_dates.category`, which the seed already
   fetches and discards. Approved as catalog hygiene in its own right, independent of
   Events:
   - it makes Paul's "Upcoming" search filter honest, and
   - it stops the app's **on-device** reminders firing on 31 Dec placeholders — a path
     that never touches the backend.
   - While in there: `release_tbd` is populated on 2 of 91,806 rows. Wire it or drop it;
     leaving a decorative safeguard is how this bit us.

### Session B — Release-Day Tracker, in full

Buildable *fully* only because A fixed its data. `game_watches` + RLS + `watcher_count`,
the watch/unwatch toggle, and the `notifications` migration for a system-actor
`game_release` kind (nullable `actor_id`, extended `kind` check, `game_id`, relaxed
`no_self_notification`, extended dedupe index — see §3).

**Ordering is load-bearing:** doing the date fix in A is what removes the junk-feed risk
from B. Reversed, Release-Day gets built twice.

### Community Meetup — parked

Not scheduled. It is the only one of the three that lets users publish content other
users see, and the safety call on user-authored `location` text is a deliberate decision,
not something that should ride along inside an Events sprint.

---

## 5. Open questions, re-pointed

Sola's four questions are superseded for build purposes by §4. These remain worth
answering, and two are for Sola rather than Paul:

1. **For Sola** — what is "Passport stamps" and what does it compute from? It's named as
   the foundation challenges tie into, and no such table, column, function or doc exists
   in this repo.
2. **For Sola** — are the on-device release reminders live in the shipped build? If so
   they are already firing on placeholder dates today.
3. **For whoever owns the seed** — was `release_tbd` ever wired, or has it always been
   decorative?
4. **Deferred** — whether Events eventually holds more than one of the three. The first
   one shapes what "Events" means to a user opening it cold.

---

Measured 17 Sep 2026 against the live project via service-role reads. Catalog state:
91,806 games (post-widening, 15 Sep). All paging done with an explicit `.order()` —
an unordered `.range()` over this table reads a different slice each run.
