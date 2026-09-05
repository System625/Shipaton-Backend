# Shelf backend

Games catalog, share ingestion and roulette for **Shelf**, a game backlog tracker.
Entry for the RevenueCat Shipaton 2026 (**due 30 Sep 2026, 11:45pm PDT**).

Supabase (Postgres + edge functions) in front of [IGDB](https://www.igdb.com/api).
The Expo app never talks to IGDB — it cannot, IGDB blocks browser/CORS requests to
avoid leaking the token, and the credentials must not be in the bundle.

```
Expo app
   |
   v
Supabase Edge Function   (holds the IGDB credentials)
   |                \
   v                 v
Postgres          IGDB API
```

**The build spec is [`docs/spec.md`](docs/spec.md).** It is written so you can
implement from it without redoing the research, and every external claim in it was
checked against the vendor's own documentation on 4 Sep 2026. Read it before
changing anything here. [`docs/STATUS.md`](docs/STATUS.md) is the pickup doc — what
is built, what is blocked, and what to do next, in order.

## Layout

```
docs/STATUS.md                   start here: state, blockers, next steps
docs/spec.md                     the build spec and all the reasoning
docs/research/                   independent cross-check reports
supabase/migrations/             schema, RLS, matching, search + roulette SQL
supabase/functions/_shared/      IGDB client, ingest, CatalogGame, oEmbed
supabase/functions/<name>/       one edge function per endpoint
scripts/                         local seed + smoke scripts (Node, not Deno)
```

## Setup

```sh
npm install
cp .env.example .env          # then fill it in — see the notes in the file
npx supabase login
npx supabase link --project-ref <your-project-ref>
npx supabase db push          # applies supabase/migrations in order
npm run seed                  # platforms, then games. ~1 min for a 3-year subset.
```

IGDB credentials are a **Twitch** application's Client ID and Secret
(<https://dev.twitch.tv/console/apps>). Then push them to the deployed functions:

```sh
npx supabase secrets set TWITCH_CLIENT_ID=... TWITCH_CLIENT_SECRET=...
npx supabase functions deploy
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into deployed functions automatically; they only need to be in `.env` for
`npm run functions:serve` and the local seed scripts.

## Endpoints

All authenticated. All return `CatalogGame` as defined in
`supabase/functions/_shared/catalog-game.ts`.

| Method | Path | Returns |
|---|---|---|
| `GET`  | `/search?q=` | `CatalogGame[]` |
| `GET`  | `/games/:id` | `CatalogGame` |
| `POST` | `/share-resolve` `{url}` | `{intakeId, extractedText, candidates[]}` |
| `POST` | `/share-confirm` `{intakeId, gameId}` | `LibraryEntry` |
| `GET`  | `/roulette?platform=&hours=&size=` | `CatalogGame \| null` |

## Things that will bite you

- **The seed is a script, not an edge function.** Free-plan functions cap at 2s CPU
  and 150s wall clock. A bulk seed blows through both.
- **`pg_trgm` lives in the `extensions` schema on Supabase**, not `public`. If
  `similarity()` or `%` reports "function does not exist", that is the search path,
  not a missing extension.
- **Filter `game_type = 0`.** Without it, "Elden Ring" returns the base game, Shadow
  of the Erdtree, the Deluxe bundle and assorted packs as separate rows, and they all
  land on the confirm screen. This is the single easiest way to make the share
  feature look broken.
- **`critic_score` is IGDB's aggregate of external critic scores. It is not
  Metacritic** and must not be labelled that in the UI.
- **IGDB attribution is a requirement**, not a nicety: visible, user-facing, static
  location. It is part of the commercial partnership terms.
- **Free-tier Supabase projects pause after 1 week of inactivity.** Shipaton judging
  runs to 22 Oct. Budget the $25 Pro plan or keep the project deliberately warm.
- **`igdb_id` is a reference, not an identity.** Nothing outside the sync layer reads
  it. That rule is what kept the RAWG→IGDB switch to one afternoon.
