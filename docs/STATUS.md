# Shelf backend — where things stand

**Last updated 5 September 2026.** Ship deadline **30 Sep 2026, 11:45pm PDT**;
judging runs to **22 Oct**.

This is the pickup doc. Read it, then `docs/spec.md` for any *why* it doesn't
answer. The spec is the authority — every external claim in it was checked against
the vendor's own documentation on 4 Sep, so don't redo that research.

---

## The one-paragraph version

The backend is fully scaffolded and typechecks, but **nothing has been run against
a real service yet**. No migration has touched Postgres, no IGDB call has been made
with real credentials. Two things gate that: Supabase MCP authentication (a
`/mcp` command away) and Twitch credentials (**blocked**, see below). Everything
between here and a working `/search` on real data is about an afternoon, once the
credentials exist.

---

## Blocked right now

**Twitch will not accept the phone number, so there are no IGDB credentials.**

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

**Nothing else is blocked on this.** Only the seed needs IGDB. The migrations,
the schema check and the whole Supabase half can go ahead now.

---

## What is built

Five migrations in `supabase/migrations/`, applied in filename order:

| File | What it does |
|---|---|
| `…000100_catalog.sql` | `platforms`, `games`, `game_platforms`, `search_cache` |
| `…000200_user_data.sql` | `library_entries`, `share_intake` |
| `…000300_rls.sql` | catalog readable by `authenticated`, user data owner-only |
| `…000400_matching.sql` | `shelf_match_title()` + a trigger that keeps it current |
| `…000500_search_and_roulette.sql` | `shelf_search_games()`, `shelf_roulette()` |

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

Also done: docs moved out of `~/Downloads` into `docs/`, Supabase MCP server added
at project scope in `.mcp.json`, `.env` pre-filled with the project ref and URL.

### Two bugs already found and fixed

Found by running the extraction code rather than reading it:

1. The YouTube title cleaner dropped everything after a colon — "Hollow Knight:
   Silksong – Announcement Trailer" became "Hollow Knight". Now keeps every segment
   before the first noisy one.
2. All-lowercase hashtags like `#eldenring` cannot be word-split without a
   dictionary. Left as-is deliberately: pg_trgm scores "eldenring" against
   "elden ring" at ~0.62, above the 0.55 confident threshold. There is a comment in
   `oembed.ts` explaining the arithmetic so nobody "fixes" it later.

---

## What to do next, in order

### 1. Authenticate the Supabase MCP server

In a **regular terminal**, not the IDE extension:

```
/mcp
```

Select `supabase`, then Authenticate. After that, Claude can apply the migrations
and query the project directly instead of you driving the CLI by hand.

### 2. Fill in `.env`

Already set: `SUPABASE_PROJECT_REF`, `SUPABASE_URL`. Still needed:
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (Project Settings
→ Database → Connection string). The two Twitch values wait on the blocker above.

### 3. Push the schema

```sh
npx supabase link --project-ref sbunhrxwhraigwpidbxk
npx supabase db push
```

**This is the first real test of the SQL** — there was no Docker on this machine, so
no local Postgres to validate it against. Expect this step to surface something.

Then check the normalizer against the spec's own worked example:

```sql
select shelf_match_title('The Witcher III: Wild Hunt - Game of the Year Edition');
-- must return: the witcher 3 wild hunt
```

If `similarity()` or the `%` operator reports "function does not exist", that is the
search path, not a missing extension.

### 4. Seed the catalog — needs IGDB credentials

```sh
npm run verify:igdb      # do this first; fails in 2s instead of mid-seed
npm run seed:platforms   # must precede games
npm run seed:games
```

Then spot-check that DLC, bundles and editions did *not* come through, and record
the real database size — see the free-vs-Pro decision below.

### 5. `/search` and `/games/:id` live ← **the milestone that matters**

```sh
npm run functions:serve   # exercise both against a real JWT
npx supabase functions deploy
```

Then hand Sola the base URL so `searchCatalog` and `findCatalogGame` swap over. That
seam is the one Sola already built — keep it.

**Steps 1–5 are the whole current app on real data, and are independent of
everything below. If the deadline gets tight, that is the point worth reaching.**

### 6. Auth and library sync

Pick the auth method (open, see below). Then verify RLS actually isolates users by
signing in as two accounts and trying to read across — do not take the policy's word
for it. Then migrate the app's Zustand store from AsyncStorage-only to synced.

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
- **Free-tier Supabase pauses after 1 week of inactivity**, and judging runs to
  22 Oct. A paused backend during judging means judges open the app and it does not
  work.

---

## Open decisions

- **Free vs Pro Supabase.** Free pauses after a week idle and caps the database at
  500 MB. The seed is estimated at 100–150 MB with the trigram index, which fits but
  without headroom. **That estimate is arithmetic and has never been measured** —
  take the real number after the seed and decide on it. Budget $25/month for October
  if it is close.
- **Auth method.** Nothing in the spec settles it. Email magic link is the least
  setup; Apple sign-in becomes effectively mandatory if the iOS build ships any other
  social login.
- **`CoverColorKey`** in `_shared/catalog-game.ts` is a placeholder set of seven
  names. Confirm the real union against Sola's app and replace it, or the coloured
  swatch fallback renders wrong.
- **pg_trgm thresholds** (0.55 confident, 0.30 plausible) are a starting point, not a
  result. Tune against real queries.

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
- `docs/decisions-for-josh.md` — the seven decisions, all approved.
- `docs/technical-notes-for-sola.md` — what changes under the app scaffolding.
- `docs/research/` — the verification prompt and three independent cross-check
  reports. The Gemini one is memory-only with a March 2026 cutoff and is wrong on
  several points; weigh accordingly.
