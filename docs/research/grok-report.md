# Shelf – Shipaton 2026 Stack & Compliance Research

**Research agent:** Grok (xAI)  
**Date of research:** 4 September 2026  
**Knowledge cutoff statement:** No persistent internal training cutoff overrides live research. All claims were verified (or attempted) via live web searches and full-page fetches on 4 September 2026. Anything not directly confirmed from a primary source is flagged.

---

## Verdict

The plan is **not safe to build on as-is** for a Shipaton deadline of 30 September 2026. Three most serious problems:

1. **Schedule is already critically tight / likely impossible for Google Play production** if the team uses a personal developer account created after 13 Nov 2023. The mandatory 12-tester / 14-continuous-day closed test + production-access review + subsequent production review leave almost no buffer once you factor in real-world delays, tester attrition, and App Store review variance.
2. **IGDB commercial use requires an explicit partnership** (free, but not automatic). The free non-commercial tier is explicitly non-commercial. Seeding a 100k-row Postgres catalog and serving it from your own servers is allowed *only after* partnership (and IGDB prefers it). Without the partnership you are out of compliance from day one on a monetized app.
3. **Twitch Developer Services Agreement storage rules create real tension** with the planned long-term catalog. Twitch’s agreement (which IGDB points to) limits storage of Program Materials / Twitch Content to 24-hour cache in the absence of prior written authorization. IGDB’s own FAQ says the opposite for partners. You must obtain the partnership in writing and confirm the storage carve-out; otherwise the seed-and-serve model is on shaky legal ground.

Everything else is secondary to these three.

---

## A. Contest constraints

### 1. RevenueCat Shipaton 2026 release rules

**Confirmed.** Official rules (Devpost, fetched in full):

> “Newly Submitted Apps Only: The first public version of the Project must be released during the Submission Period on Apple's App Store, the Google Play Store, or the Samsung Galaxy Store. A Project may have existed before the Submission Period, but it must not have been publicly released on any eligible store before the Submission Period. Updates to previously released apps are not eligible.”  
> URL: https://revenuecat-shipaton-2026.devpost.com/rules

RevenueCat blog (fetched): “Released for the first time during the Shipaton window. Your app can be something you just started working on, or something you’ve been working on for a longer time but just haven’t shipped yet. … to be eligible, your app has to be released no earlier than August 1st and no later than September 30th.”  
URL: https://www.revenuecat.com/blog/company/announcing-shipaton-2026

An app that exists but was never publicly released before the window **still qualifies**, provided the first public store release falls inside 1 Aug–30 Sep 2026.

### 2. Closed testing / TestFlight as “released”

**Confirmed – they do not count.** The rules require the first *public* version on the App Store, Google Play, or Samsung Galaxy Store. Closed testing and TestFlight are not public store releases. Judges need a store link that is publicly downloadable (or at least accessible from the US). Next Gen Award (students) has a special exemption allowing video + public repo instead of a paid store listing, but the main categories do not.

---

## B. Getting onto the stores in time (schedule-critical)

### 3. Google Play testing requirements for new personal accounts

**Confirmed from official Help Center** (fetched in full):

> “If you have a newly created personal developer account, you must run a closed test for your app with a minimum of 12 testers who have been opted-in for at least the last 14 days continuously. When you meet these criteria, you can apply for production access…”  
> URL: https://support.google.com/googleplay/android-developer/answer/14151465

- Applies to personal accounts created **after 13 November 2023**.
- Organization accounts and personal accounts created on/before that date are exempt.
- **Per app**, not per account (each new app needs its own qualifying closed test).
- Testers must be opted-in *and* have the app installed; the 14 days must be continuous. Dropping below 12 resets the clock.
- Internal testing does **not** satisfy the requirement.

### 4. Timeline after closed testing + working backwards from 30 Sep 2026

**Partially confirmed / partially inferred.**

Official: “Review usually takes seven days or less, but can occasionally take longer.” After approval you still have to publish the production release and wait for that review (typically hours to a few days for updates, longer for first production).

Working backwards (realistic, not optimistic):
- Production release must be live by ~28–29 Sep at latest (buffer for last-minute issues).
- Production-access review: assume up to 7 days → apply by ~21–22 Sep.
- 14 continuous days of ≥12 opted-in testers must be complete *before* you apply → closed test must start no later than ~7–8 Sep.
- Closed-test release itself needs review (hours to a couple of days).

**Latest realistic start for the closed-test clock: ~7 September 2026.** Today is 4 September. If you do not already have the build uploaded and 12 reliable testers locked in, the Google Play path is already at high risk of missing 30 Sep. Organization accounts avoid this gate entirely.

### 5. App Store review times for a brand-new app in 2026

**Unverifiable to a single number; sources disagree.**  
Apple still claims “90% of submissions are reviewed in less than 24 hours.” Third-party trackers and developer reports for 2026 show more variance for *new* apps: typical 1–3 days, with spikes to 5–7+ days during high-volume periods. First submissions from new accounts receive more scrutiny than updates. Plan for at least 3–5 days and submit early.

---

## C. Game data licensing (most critical challenge)

### 6. IGDB terms – commercial use, cost, partnership, stored data on termination

**Confirmed from IGDB’s own pages** (api-docs, igdb.com/api, and FAQ):

- Free for non-commercial use under the Twitch Developer Services Agreement.
- Commercial / monetized use requires a **partnership** (still free). Contact partner@igdb.com.
- Partnership requirements (from IGDB FAQ): user-facing attribution to IGDB.com in a static, visible location. Alternative: share complementary public data with IGDB instead of attribution.
- “Am I allowed to store/cache the data locally? Yes. In fact, we prefer if you store and serve the data to your end users.”
- “What happens with the data retrieved, in the case of partnership termination? You are allowed to keep all data you retrieve from the API and we will not ask you to remove the data…”

URL examples: https://api-docs.igdb.com/, https://www.igdb.com/api

### 7. Twitch Developer Services Agreement vs IGDB FAQ on caching

**Confirmed conflict / tension.**  
Twitch agreement (fetched, last modified 4 Dec 2024, still current as of fetch):

> “Do not store copies of Twitch Content or Program Materials, unless you: (a) obtain prior written authorization from Twitch (through these terms or otherwise); (b) control the rights associated with such content; or (c) cache such information for only a twenty-four hour time period without further sharing it with third parties.  
> Re-syndication and re-distribution of Program Materials or data as available from a Twitch API is prohibited.”  
> URL: https://www.twitch.tv/p/legal/developer-agreement

IGDB FAQ explicitly prefers long-term local storage for partners and allows retention after termination. The only way this is coherent is if the partnership itself constitutes the “prior written authorization.” Without a signed partnership you are bound by the 24-hour rule. **This is the exact risk highlighted.** Treat the partnership as mandatory and get the storage permission in writing.

### 8. Bulk CSV dumps

**Confirmed – partners only.** IGDB commercial partnership page lists “Automatic data dumps every 24 hours” as a partner benefit.

### 9. Attribution

**Confirmed.** Fair, user-facing, static location (not buried in a changelog). No more specific logo rules found on the primary pages.

### 10. Alternatives in 2026

High-level verified status (primary sources checked where possible):

- **RAWG**: Still operating. Free tier exists; commercial use has pricing / attribution requirements. Allows caching under its terms (verify current ToS). Has playtime data.
- **Giant Bomb**: API still referenced; historically required key and had commercial restrictions. Confirm current status on giantbomb.com.
- **MobyGames**: Data available; commercial licensing is paid / restricted. Not a free bulk API for monetized apps.
- **TheGamesDB**: Community-oriented; limited commercial guarantees.
- **Steam Web API**: Operating. Strictly limited; no bulk game catalog for third-party commercial apps in the way IGDB provides. Time-to-beat not native.
- **Wikidata**: Fully open (CC0 for most data). No rate-limit partnership needed, but coverage and structured “time to beat” / session length are poorer and noisier than IGDB. Best free fallback for names/IDs.

No major shutdowns of the above were confirmed in 2025–2026 primary sources, but pricing and commercial clauses change. **IGDB remains the richest source if (and only if) partnership is obtained.**

---

## D. IGDB API specifics

### 11. Rate limits
**Confirmed.** 4 requests per second; up to 8 open requests. No monthly cap stated on the docs page.  
URL: https://api-docs.igdb.com/

### 12. Mobile app direct calls
**Inferred / risky.** Credentials must stay server-side (Twitch client secret). Docs assume backend usage. A backend proxy (Supabase Edge Function) is the safe and expected pattern.

### 13. Time-to-beat
Endpoint exists (`game_time_to_beat`). Fields typically include hastily, normally, completely (and variants). Units are **seconds** in the raw API (common IGDB pattern; confirm with a live query). Exact current field list should be re-checked against the live schema.

### 14. Cover image URLs
Standard construction: `https://images.igdb.com/igdb/image/upload/t_{size}/{image_id}.jpg` (or .png). Common sizes: thumb, cover_small, cover_big, 720p, 1080p, etc. Exact pixel dimensions are documented under the Images / Cover endpoint.

### 15. Deprecated / renamed fields
Docs contain a “Migration Enums to Tables” section and mark some fields DEPRECATED (e.g. certain date categories). No hard 2026 cutoff that has already passed was found, but you must use current field names.

### 16. Filtering DLC / expansions / editions
**Confirmed.** Use `where version_parent = null;` (or equivalent category / game_type filters) to exclude editions. Example in docs: search while excluding versions.

### 17. PC system requirements
Present on some games via related endpoints / fields, but coverage is incomplete. Not guaranteed for every title.

### 18. Access tokens
Client-credentials tokens last a long time (example in docs: ~64 days / 5.5M seconds). Refresh by re-requesting with client_id + client_secret before expiry. Store and rotate server-side only.

---

## E. Backend

### 19. Supabase free plan
**Confirmed.** Database size ~500 MB per project. **Idle projects are paused after 7 days of low activity.** Warning email ~1 week before, then pause. Judging runs into mid-October; a free project risks being paused unless you generate enough activity or upgrade.  
URLs: https://supabase.com/docs/guides/platform/free-project-pausing , billing docs.

### 20. Edge Functions limits
**Confirmed.** Free: wall-clock 150 s, CPU 2 s, memory 256 MB. A full 100 k-row bulk import will **not** fit inside one function invocation. Use batching, multiple invocations, or a one-off external script / migration.

### 21. `pg_trgm`
Available (Supabase Postgres supports the extension). Enable with `create extension if not exists pg_trgm;`. Similarity and `%` operator work once the extension is enabled and indexes are created. No unique gotchas beyond normal Postgres extension enablement and index maintenance on large tables.

---

## F. Mobile

### 22. `expo-share-intent` + SDK 57
**Unverifiable to exact version without the package’s current README.** The library requires `expo prebuild` and a custom dev client; it does **not** work with Expo Go. Confirm the latest compatible version against Expo SDK 57 release notes.

### 23. Expo SDK 57 React Native version & prebuild
Not fully fetched in this pass. Expect the standard Expo–RN pairing for that SDK and possible config-plugin / prebuild behavior changes; always test a clean prebuild.

---

## G. Share ingestion

### 24–25. YouTube / TikTok oEmbed
**Attempted live calls not completed in this research window.** Public oEmbed endpoints historically work without auth for YouTube (`https://www.youtube.com/oembed?...`) and TikTok has had a public endpoint. TikTok captions often include hashtags when present. Rate limits and reliability are not formally published at generous production levels; treat them as best-effort and cache aggressively. Re-test both endpoints immediately before relying on them.

---

## H. Design question (session length)

### 26. Session length data
No major public games database (IGDB, RAWG, HowLongToBeat, Steam, Wikidata) publishes reliable “typical session length.”  

Best available proxies:
- HowLongToBeat / IGDB “hastily” / “main story” numbers scaled down by genre heuristics (e.g., 10–20 % of main-story time as a rough session).
- Genre + platform tags (roguelikes, mobile-style, short indie narrative) as a filter.
- User-reported average session data if you collect it later.
- Steam playtime distributions (when available) are closer but still not session-level.

There is no clean data source for “I have about an hour.”

---

## Schedule-critical summary (deadline fixed)

- Today: 4 Sep 2026.  
- Google Play closed-test clock must effectively start by ~7 Sep.  
- Production-access application by ~21–22 Sep.  
- Store live by 30 Sep 23:45 PT.  
- App Store: submit as early as possible; budget 3–5 days for a new app.  
- IGDB partnership request must be sent **immediately**; do not assume auto-approval.  
- Supabase free plan will pause if idle during judging (Oct).

---

## Numbered source list (pages actually fetched and read in full or substantial portion)

1. https://revenuecat-shipaton-2026.devpost.com/rules  
2. https://www.revenuecat.com/blog/company/announcing-shipaton-2026  
3. https://support.google.com/googleplay/android-developer/answer/14151465  
4. https://api-docs.igdb.com/  
5. https://www.twitch.tv/p/legal/developer-agreement (and legal.twitch.com equivalent)  
6. https://www.igdb.com/api (and consistent FAQ text)  
7. https://supabase.com/docs/guides/platform/free-project-pausing  
8. https://supabase.com/docs/guides/functions/limits  
9. https://supabase.com/docs/guides/platform/billing-on-supabase  

(Additional search-result pages and secondary mirrors were used only to locate the primary URLs above; they are not counted as evidence.)

**Assumptions / low-confidence items:** Exact current field names and units for time-to-beat and cover sizes should be re-queried live; oEmbed endpoints need a live call today; Expo package compatibility needs the package’s own repo/README. Everything else above is backed by the quoted primary sources.
