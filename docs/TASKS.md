# Shelf backend — build order

Derived from `spec.md` section 9. Ship deadline **30 Sep 2026, 11:45pm PDT**;
judging runs to **22 Oct**. Started 5 Sep 2026.

Steps 1–3 are the whole current app on real data and are independent of everything
else. **If the deadline gets tight, that is the point worth reaching.**

---

## 0. Scaffolding — done, 5 Sep

- [x] Repo at `~/Work/shelf-backend`, docs moved out of `~/Downloads`
- [x] Migrations: catalog, user data, RLS, title matching, search + roulette RPCs
- [x] Shared modules: IGDB client, ingest/mapping, session fit, CatalogGame, oEmbed
- [x] Five edge functions
- [x] Seed scripts (`platforms`, `games`) and an oEmbed smoke script

## 1. Supabase project live

- [ ] `npx supabase link --project-ref <ref>` against the standby project
- [ ] `npx supabase db push` — confirm `pg_trgm` and `unaccent` land in `extensions`
- [ ] Sanity-check the normalizer against the spec's own example:
      `select shelf_match_title('The Witcher III: Wild Hunt - Game of the Year Edition');`
      must return `the witcher 3 wild hunt`
- [ ] Decide free vs Pro. Free pauses after 1 week idle and caps the DB at 500 MB;
      the seed is estimated at 100–150 MB with the trigram index, which fits but
      without much headroom. **That estimate is arithmetic, never measured — check
      the real figure after the seed and settle the plan question on the number.**

## 2. Catalog seeded

- [ ] Twitch app created, Client ID + Secret in `.env`
- [ ] `npm run seed:platforms` (must run first — game platform links FK to it)
- [ ] `npm run seed:games`. Resumable: the script prints `SEED_RESUME_AFTER_ID`
      each page, so an interrupted run picks up where it stopped.
- [ ] Spot-check that DLC, bundles and editions did *not* come through
- [ ] Measure the actual DB size and record it here

## 3. `/search` and `/games/:id` live  ← the "app works on real data" milestone

- [ ] `npm run functions:serve`, exercise both against a real JWT
- [ ] Deploy, then hand Sola the base URL so `searchCatalog` and `findCatalogGame`
      can swap over. That seam is the one Sola already built; keep it.
- [ ] Tune the pg_trgm thresholds (0.55 confident / 0.30 plausible) against real
      queries. Those numbers are a starting point, not a result.

## 4. Auth and library sync

- [ ] Pick the auth method with Josh (see open questions below)
- [ ] Verify RLS actually isolates users — sign in as two accounts and try to read
      across. Do not take the policy's word for it.
- [ ] Migrate the app's Zustand store from AsyncStorage-only to synced

## 5. Share ingestion

- [ ] Deploy `/share-resolve`. **First thing after deploy: call it against a real
      YouTube link and a real TikTok link from the deployed function, not from a
      laptop.** The oEmbed verification on 4 Sep was done from a residential IP; a
      cross-check report claims datacenter IPs get throttled or 403'd, and that half
      is untested. If it 403s deployed and works locally, that is why — fall back to
      the page's OpenGraph tags. `npm run smoke:oembed <url>` gives the local baseline.
- [ ] Collect ~20 real gaming TikTok captions and measure how often the top
      candidate is right. Caption extraction is guesswork until this happens.
- [ ] `expo-share-intent` + prebuild on Sola's side (this loses Expo Go)

## 6. Roulette

- [ ] Deploy `/roulette`, then actually roll against a seeded backlog
- [ ] Sanity-check the thing the two-input split exists to prevent: a backlog of
      big RPGs must never return null just because the session is short

---

## Open questions and external dependencies

**Chase these; they do not resolve themselves.**

- [ ] **Google Play account: personal or organisation?** Still unanswered by Josh —
      it was a question rather than a numbered decision, which is likely why it
      slipped. A personal account created after 13 Nov 2023 needs 12 testers opted
      in for 14 continuous days *before* production access, and once Google's review
      time is counted the real cutoff for starting that closed test was **~6 Sep**.
      All three cross-check reports converged on 6–8 Sep. This is the live risk on
      the whole entry and it is not a backend problem — but it is the one worth
      asking about first.
- [ ] **IGDB partnership email to partner@igdb.com.** Josh agreed to send it on
      4 Sep; unconfirmed whether it went. Nothing in the build waits on the reply,
      but the request needs to be on record dated before ship. No published
      turnaround exists, so assume no answer inside the contest window.
- [ ] **`CoverColorKey`** in `_shared/catalog-game.ts` is a placeholder set of seven
      names. Confirm the real union against Sola's app and replace it, or the swatch
      fallback renders wrong.
- [ ] **Auth method.** Nothing in the spec settles it. Email magic link is the least
      setup; Apple sign-in is effectively required if the iOS build offers any other
      social login.
