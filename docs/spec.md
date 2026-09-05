# Shelf: Games DB and ingestion spec

**Owner:** Tunde
**Date:** 4 September 2026
**Status:** approved and ready to build against
**Approved by Josh, 4 September, all seven decisions:** IGDB as the data source, Supabase backend, scope cut to share / roulette / finish card, model redesign, confirm before add, drop Expo Go, and the two-input roulette.

**Correction, 4 September, now settled.** Josh originally approved RAWG on my recommendation. That recommendation was wrong, this spec uses **IGDB**, and Josh has re-approved on the corrected reasoning in section 1.

**One external dependency is still open.** The IGDB commercial partnership email to partner@igdb.com. Josh has agreed to send it and is sending it later today, 4 September. Nothing in the build waits on the reply — see section 1 for why — but the request needs to be on record dated before we ship, so if it has not gone by end of day, chase it.

**Verification pass, 4 September.** Every external claim in this spec was re-checked against the vendor's own documentation rather than search results. The IGDB claims held, several word for word. Eight things did not, and they are now fixed in place: the partnership scope in section 1, the dump availability in section 2, the field migration in section 4, the missing game type filter in sections 4 and 5, the PC requirements that IGDB does not have, the Supabase limits in section 9, and the stale RAWG quota that was still sitting in section 10. Section 11 is new and covers what happens if IGDB says no.

This is the build spec. It is written so someone can implement from it without re-reading the research.

---

## 1. Provider: IGDB, not RAWG

I originally recommended RAWG because IGDB's commercial terms looked unresolved. I was working from a 2020 forum post. IGDB's current documentation and partnership page say something quite different, verified 4 September 2026.

From the IGDB API FAQ, verbatim:

> **I want to use the API for a commercial project, is it allowed?**
> Yes, we offer commercial partnerships for users looking to integrate the API in monetized products. From our side, as part of the partnership, we ask for user facing attribution to IGDB.com.

> **What is the price of the API?**
> The API is free for both non-commercial and commercial projects.

> **Am I allowed to store/cache the data locally?**
> Yes. In fact, we prefer if you store and serve the data to your end users.

> **What happens with the data retrieved, in the case of partnership termination?**
> You are allowed to keep all data you retrieve from the API and we will not ask you to remove the data.

The partnership page adds that partners get automatic data dumps every 24 hours, may store data on their own servers, and get PopScore trend data.

### Comparison

| | IGDB | RAWG |
|---|---|---|
| Commercial use | Free, via partnership | Free under 100k MAU |
| Monthly request cap | None. 4 req/sec | **20,000 requests** |
| Cost above that | n/a | $149/month for 50,000 |
| Store on our servers | Explicitly encouraged | Redistribution prohibited |
| Bulk data dumps | Every 24 hours | None |
| Data if we leave | We keep all of it | n/a |
| Time to beat | `hastily` / `normally` / `completely` + `count` | single averaged `playtime` |
| Cover art | Real box art (`t_cover_big`) | `background_image`, a screenshot |
| Popularity | PopScore | `added`, `rating` |
| Catalog | 374,515 games | comparable |
| Attribution | Visible, static location | Link on every page using data |

IGDB is better on every axis that matters to us, and the 20,000 request ceiling that drove the whole original architecture simply does not exist.

### The partnership is not just paperwork

This is the part I originally understated. The FAQ above is accurate, but IGDB's Getting Started page says something the FAQ does not:

> The IGDB.com API is free for **non-commercial** usage under the terms of the Twitch Developer Service Agreement.

That agreement, Schedule 1 section C, says:

> Do not store copies of Twitch Content or Program Materials, unless you: (a) obtain prior written authorization from Twitch (through these terms or otherwise); (b) control the rights associated with such content; or (c) cache such information for only a twenty-four hour time period without further sharing it with third parties.

Our entire design is a seeded Postgres catalog served to our users, and Shelf ships with a RevenueCat paywall, so it is a monetized product from day one. The partnership is what authorizes the architecture in section 2. It is not a formality we can leave running in the background.

To be fair to IGDB, their FAQ does say caching is encouraged and is not explicitly scoped to partners, so there is real ambiguity here rather than a clear violation. The partnership resolves it in writing, which is why it matters.

**How we proceed.** The free API is instantly available with a Twitch account and gives us every field we need, so building starts today and nothing is blocked. Attribution goes in the UI from day one, since it is required either way. The email to partner@igdb.com comes from Josh, since it needs to come from whoever owns the business side, and we want the request on record dated before we ship. **Approved 4 September; Josh is sending it that day.** Treat it as the one item in this spec with an external party on the other end, and do not let it go quiet.

I could not find any published turnaround time for that email, so plan for no reply inside the contest window. Nothing in this spec depends on getting one.

---

## 2. Architecture

```
Expo app
   |
   v
Supabase Edge Function  (holds IGDB credentials, never in the bundle)
   |                \
   v                 v
Postgres          IGDB API
```

The app never talks to IGDB. This is not just good practice, IGDB requires it. From their technical FAQ:

> The IGDB API does not support browser requests, CORS, for security reasons. This is because the request would leak your access token! We suggest that you create a backend proxy.

That settles Josh's decision 2 independently of the sync and auth arguments.

Because IGDB encourages local storage, the catalog strategy changes from the original plan. Rather than lazily filling on cache miss, we **seed the catalog up front** and refresh on a schedule. Live API calls become the exception rather than the norm.

**Seed from the paginated API, not from a dump.** The CSV dumps are partner only. From IGDB's docs, verbatim:

> Please note that data dumps are exclusively available to our Data Partners.

This is not a problem. `limit` maxes at 500 and we get 4 requests per second, so 100,000 games is roughly 200 requests, about a minute of wall time. Page by sorting on id and filtering `where id > last_id` rather than using deep `offset`. If the partnership lands, the dumps become an optimisation we can adopt later, not a dependency we have to wait for.

For the hackathon, seed a subset rather than all 374,515 games: everything from the last 3 years, plus anything popular enough to matter. Full coverage can wait.

Auth note: cache the token, do not request one per call. Read the `expires_in` field from the token response rather than hardcoding a lifetime. IGDB's own example returns `5587808` seconds, about 64 days, but read the field. I could not verify the "25 active tokens" limit anywhere in current Twitch documentation, so do not design around it.

---

## 3. Schema

```sql
create extension if not exists pg_trgm;

-- Seeded once from IGDB /platforms, then effectively static.
create table platforms (
  id      int  primary key,        -- IGDB's platform id
  slug    text not null unique,
  name    text not null,
  family  text                     -- 'playstation' | 'xbox' | 'nintendo' | 'pc' | 'mobile'
);

create table games (
  id                  uuid primary key default gen_random_uuid(),
  igdb_id             int unique,           -- null for user-created games
  rawg_id             int unique,           -- reserved, see section 11
  slug                text,
  title               text not null,
  match_title         text not null,        -- normalized, see section 5
  release_date        date,
  release_tbd         boolean not null default false,
  cover_url           text,
  genres              text[] not null default '{}',
  critic_score        smallint,             -- IGDB aggregated_rating. NOT Metacritic, see section 4
  igdb_game_type      smallint,             -- 0 = main game, see section 4
  ttb_hastily_hours   numeric(5,1),         -- IGDB hastily / 3600
  ttb_normally_hours  numeric(5,1),         -- IGDB normally / 3600, the default
  ttb_completely_hours numeric(5,1),        -- IGDB completely / 3600
  ttb_count           int,                  -- submissions behind the estimate
  session_fit         text,                 -- 'high' | 'medium' | 'low', see section 7
  source              text not null default 'igdb',  -- 'igdb' | 'user'
  synced_at           timestamptz,
  created_at          timestamptz not null default now()
);

create index games_match_title_trgm on games using gin (match_title gin_trgm_ops);
create index games_ttb on games (ttb_normally_hours);
create index games_session_fit on games (session_fit);

create table game_platforms (
  game_id     uuid not null references games(id) on delete cascade,
  platform_id int  not null references platforms(id),
  primary key (game_id, platform_id)
);

-- Saves round trips on repeat searches. Less critical under IGDB than it was
-- under RAWG, but still worth having.
create table search_cache (
  query_norm  text primary key,
  game_ids    uuid[] not null,
  fetched_at  timestamptz not null default now()
);
```

`id` is ours. `igdb_id` is a reference, not an identity. Nothing outside the sync layer should ever read `igdb_id`. This is what let the provider change from RAWG to IGDB in one afternoon without touching any other table, and it is why the rule is worth keeping.

### User data (the contract other features build on)

```sql
create table library_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  game_id       uuid not null references games(id),
  status        text not null check (status in ('playing','backlog','beaten','dropped')),
  rating        smallint check (rating between 1 and 10),
  notes         text not null default '',
  hours_played  numeric(5,1),
  platform_id   int references platforms(id),   -- what THEY play it on
  source_url    text,                            -- the TikTok / YouTube link
  source_kind   text check (source_kind in ('tiktok','youtube','search','manual')),
  added_at      timestamptz not null default now(),
  finished_at   timestamptz,
  unique (user_id, game_id)
);
```

`source_url` is the differentiator. It is also what makes the finish card interesting: "found on TikTok in March, beaten in September" beats a bare rating.

### Share intake

```sql
create table share_intake (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  raw_url            text not null,
  provider           text,          -- 'tiktok' | 'youtube' | 'other'
  extracted_text     text,          -- the oEmbed title or caption
  candidate_game_ids uuid[] not null default '{}',
  status             text not null default 'pending',
                     -- 'pending' | 'matched' | 'unmatched' | 'dismissed'
  matched_game_id    uuid references games(id),
  created_at         timestamptz not null default now()
);
```

A row is written the instant a share arrives, before any matching. If resolution fails, the link is still saved and the user can come back to it. Nothing a user shares is ever silently dropped.

---

## 4. IGDB field mapping

IGDB uses POST with an Apicalypse query body, not query string params. Base URL `https://api.igdb.com/v4`, headers `Client-ID` and `Authorization: Bearer {token}`.

```
POST https://api.igdb.com/v4/games
fields name, slug, first_release_date, cover.image_id, genres.name,
       platforms, aggregated_rating, game_modes.name, keywords.name,
       game_type, parent_game, version_parent;
search "elden ring";
limit 20;
```

`limit` defaults to 10 and maxes at 500.

### Filter out everything that is not a game

Without this, searching "Elden Ring" returns the base game, Shadow of the Erdtree, the Deluxe bundle and assorted packs, all as separate rows. They land on the confirm screen and in the roulette pool. IGDB's type values:

```
main_game 0   dlc_addon 1   expansion 2   bundle 3   standalone_expansion 4
mod 5   episode 6   season 7   remake 8   remaster 9   expanded_game 10
port 11   fork 12   pack 13   update 14
```

At ingest, keep `game_type = 0` and drop rows where `parent_game` or `version_parent` is set. `parent_game` marks DLC and bundle contents. `version_parent` marks editions, which is the "Game of the Year Edition" problem section 5 solves with string surgery. Filtering structurally here is cleaner than normalizing it away afterwards, and the two work together.

### Field migration, already past its deadline

IGDB moved from enum values to lookup tables. On the games endpoint the docs now carry, verbatim, `category : DEPRECATED! Use game_type instead` and `status : DEPRECATED! Use game_status instead`. Elsewhere `platform.category` became `platform_type` and `website.category` became `type`.

A correction to an earlier draft of this spec: it dated the end of the migration window to 31 August 2026. IGDB's page says only "Migration Period: starting on February 18 to August 31 (6 months)" and names **no year at all**, so that date was an inference and is withdrawn. It changes nothing practical. Both old and new names still resolve as of 4 September 2026, and the per-endpoint DEPRECATED markers above are read straight off the live docs, which is better evidence than the timeline was. Use the new names.

Nothing in this spec uses a removed name, but wrappers, tutorials and generated snippets written before September will, so treat any example you find online as suspect.

| IGDB | ours | note |
|---|---|---|
| `id` | `igdb_id` | reference only |
| `name` | `title` | |
| `slug` | `slug` | |
| `first_release_date` | `release_date` | **unix seconds**, convert |
| `cover.image_id` | `cover_url` | build the URL, see below |
| `genres.name` | `genres` | |
| `platforms` | `game_platforms` | the many-to-many |
| `aggregated_rating` | `critic_score` | "Rating based on external critic scores", 0 to 100. **Not Metacritic.** Do not label it that in the UI |
| `game_type` | `igdb_game_type` | 0 is a main game, see the filter below |
| `game_modes.name` | session fit input | see section 7 |
| `keywords.name` | session fit input | includes roguelike and similar |

Time to beat is a **separate endpoint**, keyed by game:

```
POST https://api.igdb.com/v4/game_time_to_beats
fields hastily, normally, completely, count;
where game_id = 1942;
```

Returns **seconds**, not hours. Divide by 3600. `count` is how many submissions back the estimate, so treat a low count as low confidence. Verified against two independent client libraries.

Cover URLs are built by hand from `image_id`:

```
https://images.igdb.com/igdb/image/upload/t_cover_big/{image_id}.jpg
```

The default returned URL is `t_thumb` and is too small to use. `t_cover_big` is only 264 x 374, so append `_2x` for 528 x 748 on phone displays. An invalid size token 404s rather than falling back, so get it right. Note IGDB images that are removed or replaced stay live for 30 days, so cache logic should refresh within that window.

---

## 5. Title matching

Two places need this: search, and working out what a shared video is about.

### Normalizing into `match_title`

Applied to both catalog titles and incoming query text:

1. lowercase
2. strip diacritics
3. remove edition suffixes: `definitive edition`, `goty`, `game of the year`, `remastered`, `remake`, `deluxe`, `complete edition`, `director's cut`, `enhanced edition`
4. normalize roman numerals to digits (`ii` to `2`, `iii` to `3`, up to `x`)
5. strip all punctuation, collapse whitespace

So "The Witcher III: Wild Hunt - Game of the Year Edition" becomes `the witcher 3 wild hunt`.

Step 3 matters more than it looks. Without it "Skyrim" and "Skyrim Special Edition" are two separate games in everyone's backlog.

### Scoring

```sql
select id, title, similarity(match_title, $1) as score
from games
where match_title % $1          -- pg_trgm threshold
order by score desc
limit 5;
```

Thresholds: `>= 0.55` show as confident best guess. `0.30` to `0.55` show as a list of options. `< 0.30` treat as unmatched.

Tune these against real captions once we have any. The numbers are a starting point, not a result.

---

## 6. Share ingestion

### Getting text out of a link

Both endpoints are public and need no auth. Verified working on 4 September 2026.

**Caveat on that verification, added after the cross-check.** Those calls were made from a laptop on a residential connection, not from a Supabase edge function. One cross-check report claims both endpoints throttle or 403 requests from datacenter IP ranges, Supabase and AWS included, and that a browser-like `User-Agent` is needed. I could not reproduce the User-Agent half: on 4 September both endpoints returned 200 from this machine with a browser UA, with no UA at all, and with curl's default. The datacenter-IP half is untestable from here and remains unverified. Treat it as plausible and cheap to insure against:

- Send a normal browser `User-Agent` from the edge function anyway. It costs one header.
- **The first thing to do after `/share/resolve` is deployed is call it against a real YouTube and a real TikTok link from the deployed function, not from a laptop.** If it 403s there and works locally, this is why, and the answer is to cache aggressively and fall back to the OpenGraph tags on the page.
- Cache every resolved URL. TikTok's endpoint is undocumented and offered as a courtesy; hammering it is the fastest way to lose it.

**YouTube:** `https://www.youtube.com/oembed?url={url}&format=json`

Returns a clean title. Real response:

```
"ELDEN RING - Official Gameplay Reveal"
```

Strip trailing noise before matching: split on ` - `, ` | `, `:` and drop trailing segments containing `official`, `trailer`, `gameplay`, `review`, `walkthrough`, `part \d+`, `ep \d+`.

**TikTok:** `https://www.tiktok.com/oembed?url={url}`

Returns the entire caption in `title`. Real response:

```
"Scramble up ur name & I'll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic"
```

Gaming captions look the same. Something like "this boss took me 3 hours 💀 #eldenring #soulslike".

Extraction order, best signal first:

1. **Hashtags.** Strip `#`, split camelCase, expand. `#eldenring` gives "elden ring". On TikTok this is the strongest signal by a distance, because people tag the game even when the caption never names it.
2. **Quoted strings** in the caption.
3. **Whole caption** with emoji and hashtags removed, as a fuzzy query.

Ignore generic tags: `foryou`, `foryoupage`, `fyp`, `viral`, `gaming`, `gamer`, `tiktokgaming`. Keep a stoplist.

### The flow

```
share arrives
  -> write share_intake row (status: pending)
  -> resolve oEmbed
  -> extract candidate text
  -> score against catalog
  -> if no local hit, one IGDB search
  -> store top 5 candidates
  -> app shows confirm screen
  -> user taps
       confirm  -> library_entries row with source_url, intake status 'matched'
       none of these -> search box, intake stays 'unmatched'
```

The confirm step is required. Best guess large at the top, two or three alternatives under it, and a search box for when we are completely wrong. Silently adding the wrong game to someone's backlog is the fastest way to kill trust in the one feature that makes this app different.

---

## 7. The roulette, and a problem with it

The intended query:

```sql
select g.*
from library_entries le
join games g on g.id = le.game_id
join game_platforms gp on gp.game_id = g.id
where le.user_id = $1
  and le.status = 'backlog'
  and gp.platform_id = $2
  and coalesce(g.ttb_normally_hours, 999) <= $3
order by random()
limit 1;
```

Platform filters on `game_platforms`, meaning "is this game playable on the PS5 I am sitting in front of", not what the user tagged. Users will not tag reliably.

**The problem, and it is not only the 1 hour case.**

"I have 1 hour" means an hour free tonight. Time to beat is how long the whole game takes to finish. These are different quantities on different scales, and the mismatch holds across the entire range, not just at the bottom.

Session lengths people actually enter run 30 minutes to about 4 hours. Completion times run 2 to 100 hours. Illustrative:

| Game | Approx hours to beat |
|---|---|
| Journey | 2 |
| Portal | 3 |
| Firewatch | 4 |
| Celeste | 8 |
| Doom (2016) | 11 |
| God of War | 20 |
| Hollow Knight | 27 |
| Elden Ring | 55 |
| Persona 5 | 100 |

Filter at 2 hours and you get Journey. At 4 hours you add Portal and Firewatch. The pool is not worth rolling against until roughly 10 hours, by which point you are answering a different question.

The real failure is not pool size. Everything under 4 hours is the **same kind of game**, short narrative indies. So the roulette deals the same handful of titles to everyone forever, and never surfaces the 55 hour game you have 40 hours left in. A user whose backlog is mostly big RPGs gets an empty roll every time.

This is not a threshold to tune. It is two different questions sharing a unit.

### Resolution

Split them.

**Question 1, session: "how long have you got?"** Does not filter on time to beat at all. It uses **structure**, which is what actually predicts whether a game works in a short window.

Run based games are built out of short sessions. Story games are not. Balatro's total playtime is effectively unbounded and it is the best 45 minute game in the current mock catalog, which is the clearest proof that duration was never the right input.

Derive a `session_fit` score on the game row from IGDB `genres`, `game_modes` and `keywords`:

| Signal | Fit |
|---|---|
| `genres`: Racing, Sport, Fighting, Puzzle, Arcade, Pinball, Quiz/Trivia, Card & Board Game | high |
| `keywords`: roguelike, roguelite, score attack, endless | high |
| `game_modes`: Battle Royale | high |
| `genres`: Platform, Shooter, Hack and slash/Beat 'em up, Music | medium |
| `genres`: Role-playing (RPG), Strategy, Simulator, Turn-based strategy, MMO | low |
| `genres`: Adventure, Visual Novel, Point-and-click with time to beat > 20h | low |

Then, as the window shrinks:

- games already `playing` rank higher, since resuming beats starting
- high `session_fit` ranks higher
- long unstarted low-fit games rank lower, but are never excluded

Note this is a heuristic over genre labels, not a measured property. It should be treated as a first cut and revisited once anyone has actually used the roulette.

### Does the IGDB switch fix this?

No, and it is worth being clear about why, because the provider change fixed several other things.

IGDB's `game_time_to_beats` returns `hastily`, `normally` and `completely`. All three are total completion figures. `hastily` for Elden Ring is still roughly 30 hours. No games database publishes session length, because it is a property of the player's evening rather than of the game. Section 7 stands as written regardless of provider.

What IGDB does improve is the **size bucket** in question 2: three data points instead of one averaged number, plus `count` as a confidence signal so we know when to distrust it.

**Question 2, size: "how big a game?"** This is where time to beat genuinely works, with buckets rather than free numbers:

- Quick, under 10 hours
- Medium, 10 to 30
- Epic, 30 plus

Shape of it:

```sql
select g.*
from library_entries le
join games g  on g.id = le.game_id
join game_platforms gp on gp.game_id = g.id
where le.user_id = $1
  and le.status in ('backlog','playing')
  and gp.platform_id = $2
  and ($3::text is null or       -- size bucket, optional
       case
         when $3 = 'quick'  then coalesce(g.ttb_normally_hours, 15) < 10
         when $3 = 'medium' then coalesce(g.ttb_normally_hours, 15) between 10 and 30
         when $3 = 'epic'   then coalesce(g.ttb_normally_hours, 15) > 30
       end)
order by
  (case when le.status = 'playing' then 1 else 0 end) *
    (case when $4 < 2 then 2.0 else 0.5 end) desc,   -- $4 = session hours
  random()
limit 1;
```

Always returns something as long as the backlog is non-empty on that platform. A roulette that comes back empty is a broken roulette.

**Approved by Josh, 4 September.** This was the decision with the most product surface attached to it: it changes the UI from one input to two, and it changes the pitch line. "Tell it 1 hour and PS5" becomes something closer to "tell it how long you have got and what you are in the mood for". Sola has the mobile-side note; the two-input roulette is now the design to build.

---

## 8. Endpoints for the app

All Supabase edge functions. All authenticated.

```
GET  /search?q=                       -> CatalogGame[]
GET  /games/:id                       -> CatalogGame
POST /share/resolve   {url}           -> {intakeId, extractedText, candidates[]}
POST /share/confirm   {intakeId, gameId} -> LibraryEntry
GET  /roulette?platform=&hours=       -> CatalogGame
```

`CatalogGame` as returned:

```ts
type CatalogGame = {
  id: string;
  title: string;
  platforms: { id: number; name: string; slug: string }[];
  releaseDate?: string;
  genres: string[];
  coverImageUrl?: string;
  timeToBeatHours?: number;   // IGDB `normally`, converted from seconds
  sessionFit?: 'high' | 'medium' | 'low';
  abbreviation: string;   // derived, cover fallback
  colorKey: CoverColorKey; // derived, cover fallback
};

// Note: no pcRequirements. IGDB publishes no per-game system requirements.
// (`platform_versions` does have cpu/graphics/memory/os/storage, and a cross-check
//  report mistook these for game requirements. They describe the hardware itself,
//  e.g. a console revision, not what a given game needs to run. Not usable here.)
// The word "requirement" appears once in their entire API documentation, in an
// unrelated sentence about query filters. RAWG had this field, IGDB does not.
// It is removed rather than left permanently undefined in Sola's contract.
```

`abbreviation` and `colorKey` are derived server side from the title so the app keeps its coloured swatch fallback. Sola's existing fallback is good and cover art fails more often than you would expect.

---

## 9. Build order

1. Supabase project, `platforms` seeded, `games` and `game_platforms` created
2. IGDB sync plus field mapping, then `/search` and `/games/:id`. **Run the initial seed as a local script, not an edge function.** Edge functions cap at 2 seconds of CPU time and 150 seconds wall clock on the free plan, which a full catalog seed will blow through. Edge functions are the right home for the per-request endpoints and for incremental refresh, not for the bulk load.
3. Swap `searchCatalog` and `findCatalogGame` to call these. App works exactly as now, on real data.
4. Auth and `library_entries`, migrate the Zustand store to sync
5. `expo-share-intent` plus prebuild, `/share/resolve`, confirm screen
6. Roulette, once section 7 is settled

Steps 1 to 3 are the whole current app on real data, and are independent of everything else. If the deadline gets tight, that is the point worth reaching.

---

## 10. Risks

**Partnership scope.** The biggest one, and it is legal rather than technical. Storing IGDB data and serving it to users is authorized by the commercial partnership. Without one we are relying on an ambiguity between IGDB's FAQ and the Twitch agreement it points at. See section 1. The email should go today. Enforcement risk inside a 30 day contest window is low; the exposure grows if Shelf wins something and keeps running.

**Supabase free tier will pause on us.** From their pricing page, verbatim: "Free projects are paused after 1 week of inactivity." Judging runs to 22 October. A paused backend during judging means judges open the app and it does not work. Budget the $25 Pro plan for October, or keep the project warm deliberately. Free also caps the database at 500 MB, which our seed fits inside at roughly 100 to 150 MB with the trigram index, but without much headroom.

**Request rate, not request quota.** There is no monthly cap. The limit is 4 requests per second with a maximum of 8 open requests, and 429 on overage. That is a concurrency problem during closed testing, not a budget problem. Cache anyway.

**Cover art.** IGDB serves real box art, close to the Wikipedia art in the current mock catalog. Use `t_cover_big_2x`. Images removed from IGDB stay live 30 days, so refresh within that window.

**Type pollution.** Without the `game_type` filter in section 4, DLC, bundles and editions appear as separate games in search, on the confirm screen and in the roulette pool. This is the single easiest way to make the share feature look broken.

**Coverage.** 374,515 games, better than RAWG on obscure and older titles. `source: 'user'` exists so a user can add something missing, but nothing is built for that yet and it is not in the cut scope.

**Caption extraction.** Best guessed at until we test on real gaming TikToks. The confirm screen is what makes being wrong survivable, which is why it is not optional.

**Playtime nulls.** IGDB time to beat is a separate endpoint and not every game has an entry. Check `ttb_count` and fall back to genre based `session_fit` when it is null or low.

**Partnership latency.** No published turnaround exists for partner@igdb.com, so assume no reply inside the contest window. Nothing in this spec depends on one. See section 11 for what we do if the answer is no.

**pg_trgm on Supabase.** Extensions install into the `extensions` schema rather than `public`. If `similarity()` or the `%` operator comes back as "function does not exist", that is the search path, not a missing extension. Schema qualify or set the path.

---

## 11. If IGDB says no

I researched the alternatives properly on 4 September, against each vendor's own pages. The short version: **there is no good fallback.** That is not an argument against IGDB, it is the strongest argument for making IGDB work.

| Provider | Status | Commercial terms | Time to beat |
|---|---|---|---|
| **IGDB** | Alive, free | Free, partnership plus attribution | 3 estimates plus a count |
| **RAWG** | Alive | Its own pages contradict each other, $149/mo to be safe | 1 averaged number |
| **Giant Bomb** | **API offline** | n/a | none |
| **MobyGames** | Alive | Paid only, from about $100/mo | none |
| **TheGamesDB** | Alive | Unclear, community run | none |
| **Steam Web API** | Alive, free | Permitted, 100k calls/day | Steam playtime only |
| **Wikidata** | Alive, CC0 | Unrestricted | none |
| **HowLongToBeat** | No official API | Scraping only | The best data there is |

**Giant Bomb is dead.** Most comparison articles still list it. Their own API page today says the APIs for Games, Characters, Companies, Concepts, Locations, Objects, Releases and People are "not currently available" after they split from Fandom and rebuilt. They are asking for volunteer developers to help restore it, with no timeline. If anyone proposes Giant Bomb, that recommendation is stale.

**MobyGames is priced for enterprises.** Free API access ended in March 2025. Commercial tiers are reportedly $99.99, $499.99 and $4,999.99 a month at 1, 4 and 8 requests per second. I could not read their own pricing page because it sits behind an interactive CAPTCHA, so treat the exact figures as unconfirmed. The direction is certain: free access ended, commercial access is paid, and the cheapest tier is slower than IGDB's free one.

**RAWG is the only real fallback, and its terms contradict themselves.** Both of these are on the same page, rawg.io/apidocs. The pricing table: "Free ... **Non-commercial projects only** ... up to 20,000 requests per month". The terms of service a little further down the same page: "Free for commercial use for startups and hobby projects with not more than 100,000 monthly active users or 500,000 page views per month." Commercial use is listed as a feature of the $149/month Business plan, capped at 50,000 requests. Their terms also say "No data redistribution ... you may use the data with your API access only for your projects."

So RAWG carries the same ambiguity IGDB does, except with IGDB the resolution is a free partnership and with RAWG the resolution is $149 a month. Two things RAWG genuinely does better: real Metacritic scores, and PC system requirements, the field IGDB cannot fill.

**The others are not options.** Steam is free and official but only knows Steam, which kills the platform filter the roulette depends on. Wikidata is CC0 with about 35,000 game items against IGDB's 374,515, thousands of them missing platform or genre, and it will not host cover art. TheGamesDB has a small monthly allowance and never formalised a commercial stance. HowLongToBeat has the best playtime data in existence and no official API, only scrapers, which is not something to ship a monetized contest entry on.

### What this means for the design

**Time to beat is the scarce resource.** IGDB is the only provider that publishes it under a real licence.

A forced move to RAWG would not break Shelf, and it is worth knowing exactly how it degrades. Section 7 splits the roulette into a session question and a size question. The session question runs on `session_fit`, derived from genres, game modes and keywords, and RAWG has genres and tags, so **that survives intact**. Only the size bucket degrades, from three estimates plus a confidence count down to one averaged `playtime` number.

That is a bounded failure. The worst case is not a rewrite, it is $149 a month, coarser size buckets, screenshots instead of box art, and PC specs we gain rather than lose.

**This is why the `igdb_id` rule in section 3 matters.** Keeping the provider id as a reference that nothing outside the sync layer reads is what makes RAWG a sync layer change rather than a rewrite. It already earned its keep once when the provider changed mid research. Do not let a provider id leak into the app.
