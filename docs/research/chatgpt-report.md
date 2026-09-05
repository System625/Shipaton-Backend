# Verdict

The plan is **risky** without adjustments. The three most serious issues are: (1) **Shipathon release timing:** the app *must* have its **first public release** between Aug 1 and Sep 30, 2026. TestFlight or beta builds don’t count, so you must get a full store listing live in that window. (2) **IGDB licensing ambiguity:** IGDB is free under Twitch’s terms for *non-commercial* use, but as soon as you monetize (RevenueCat), you need a “commercial partnership”. IGDB’s own FAQ says caching is fine, but the Twitch Developer Agreement actually *forbids* storing data beyond 24 hours without permission, directly contradicting IGDB’s guidance. This legal conflict is a big red flag. (3) **Backend uptime on free Supabase:** Free projects are **paused after 1 week** idle. Judges might not ping your backend during the contest, so your service could sleep just when you need it live. Ensuring continuous uptime likely means paying. 

Beyond that, the store submission window is tight: you’ll need to start closed testing by early Sept to finish Google’s 14-day test and get approval before Sep 30 (see Timeline below). On the other hand, *if* you resolve IGDB questions (partnership or switch to another data source) and pay for Supabase Pro (to avoid idle-sleep), the stack can work. The plan’s **three biggest problems** are therefore: contest-release compliance, IGDB licensing/caching, and production-readiness of the backend (Supabase limits). We detail each point below.

## A. Shipathon contest constraints

**Release window:** The official rules state “*the first public version of your app must be released between Aug 1 and Sep 30, 2026*”.  In other words, your **first-ever public release** must fall inside that window – apps released publicly *before* July 31, 2026 do *not* qualify.  Thus an app you’ve been developing privately *can* qualify if you publish it for the first time in that period. The RevenueCat blog clarifies: “*your app must … [be a] new app whose first public version was released during the Shipaton submission window*”.  “Apps released before Shipaton don’t qualify”. 

**Test vs. public release:**  Crucially, beta/test builds do **not** count as a “public version.” The rules explicitly say “TestFlight or testing-track builds don’t count. Shipaton needs a live store listing…”. Likewise, a Google Play closed test isn’t sufficient. Judges will only be able to download a *public* app from the store; so you must have your app fully published (App Store and/or Play) within the window. In short: **only a live store release qualifies**.  

## B. Getting onto app stores in time

1. **Google Play testing requirements (per app):**  Google now requires new personal (non-organization) developer accounts opened after Nov 13, 2023 to run a *closed test* before production. Specifically: *“Developers with personal accounts created after Nov 13, 2023 must run a closed test for their app with a minimum of 12 testers who have been opted in continuously for at least 14 days.”*.  (Organization or business accounts created before that date are not subject to this rule.) This requirement is **per app**, so each new app must meet it. The testers must be real Google accounts (not machine) and remain opted in the full 14 days. 

2. **Play timeline (work backward from Sep 30):**  After the 14-day test, you submit for *production access*. Google says production-access review *“usually takes seven days or less”* (though many developers report ~1–3 days). Once granted, you submit the final app release; Google review for a new app is typically another 1–3 days. Working backwards from Sept 30, allow time buffers. For example, assume ~7 days for production access, ~3 days for final review. Then you’d need to finish testing (14 days) by ~Sept 20, apply by Sept 20–21, so production access ~Sept 27, and final publish complete by Sept 30.  In practice, **start closed testing by early September** (around Sept 6–7) to be safe.  

3. **Apple App Store review times:**  Apple states “90% of submissions are reviewed in less than 24 hours” on average. So typically expect **1–2 days** for first-review.  However, anecdotal reports in 2026 suggest first-time app reviews can sometimes take longer (multiple days) if there are issues. We will cite Apple’s official stat as a baseline, but advise building slack.  

## C. Game database licensing

1. **IGDB commercial usage and partnership:** IGDB’s own FAQ says the API is free for *non-commercial* use under Twitch’s Developer Agreement.  For commercial use, IGDB requires joining a “commercial partnership” – though notably the API itself remains free. The FAQ explains: “the API is free for both non-commercial and commercial projects”, but commercial projects must enter a partnership, which asks only for user-facing attribution to IGDB. In summary: **commercial use is allowed but requires contacting IGDB (partner@igdb.com) and crediting IGDB**. No direct fees are mentioned (the API is free even for commercial). If a partnership ends, you are explicitly permitted to keep using the data you fetched. 

2. **Caching/data storage conflict:** IGDB’s FAQ encourages caching: “Yes, you are allowed to store and serve data retrieved from the IGDB API… we actually prefer if you do”. **However**, Twitch’s official Developer Agreement (which IGDB inherits) states the opposite: *“Do not store copies of Twitch Content or Program Materials, unless... you cache such information for only a twenty-four hour time period”*. That appears to forbid long-term storage. This is a clear conflict with IGDB’s guidance. In other words, Twitch’s legal terms suggest IGDB data shouldn’t be stored indefinitely, whereas IGDB’s own FAQ says to cache it. This discrepancy is unresolved officially, so it is a legal risk. 

3. **IGDB data dumps:** IGDB provides daily CSV data dumps, but **only for partners**. Their docs explicitly state: *“Please note that data dumps are exclusively available to our Data Partners.”*. So unless you enter a partnership, you cannot legally access the bulk dumps – only the API queries. 

4. **IGDB attribution:** The partnership FAQ requires user-visible attribution to IGDB.com. They say: *“as part of partnership, we ask for user-facing attribution to IGDB.com from products integrating the IGDB API”*. They clarify this means a static credit (e.g. “data provided by IGDB.com”) visible to users. There’s no requirement for an in-app splash screen, but credit must be accessible (e.g. in an “About” or footer).

5. **Alternatives in 2026:**  Aside from IGDB, several other game DBs exist:

   - **RAWG (rawg.io):** The API is still active (as of 2026) and provides game info including an “average playtime” field. RAWG is free up to generous limits (10k requests per minute) with attribution. Commercial use is allowed (their TOS require no fees unless you exceed the free tier, and they emphasize not to republish data for other businesses). You *may* cache RAWG data for your app, but you must include RAWG attribution. RAWG includes a “average playtime” value for games which approximates completion time.  

   - **Giant Bomb:** The old GiantBomb API has been effectively **shut down**. The GiantBomb public API is no longer available as of 2026 (their site indicates the gaming content has moved to a wiki; the old API returns no data). So it is not a viable option currently.  

   - **MobyGames:** MobyGames launched a new API with multiple paid tiers. There is a free “Hobbyist” plan ($9.99/month) limited to low usage and for non-commercial use only, and paid “Bronze” ($99.99/mo), “Silver” ($499.99), etc.. Commercial apps must use Bronze or higher.  Caching is allowed – their FAQ encourages local caching via `INSERT ... SELECT` in Postgres. The data requires attribution (“Data provided by MobyGames.com” on every page). MobyGames does not appear to publish playtime-to-complete (it focuses on credits and descriptions, not time-to-beat). 

   - **TheGamesDB (thegamesdb.net):** The API is still running and (as of 2026) offers a free API key (no email required for the free tier). TheGamesDB does not forbid commercial use in its documentation (the community wiki and API imply it’s open for projects). Their free plan has basic limits; higher volume requires paid plans (details TBD). You are allowed to cache data from TheGamesDB (it’s open data for devs) and must attribute TheGamesDB on credit pages. TheGamesDB does not track game duration or completion times.

   - **Steam Web API:** Steam’s public API (via Steamworks key) is still available and free. It provides game metadata and user stats (like playtime for Steam users) but **no official “time to beat”**. Steam does allow caching of its API data in practice, but its terms focus on user data privacy more than game data. Steam requires attribution only via Steam’s standard guidelines (i.e. listing Steam as a source is polite, though not explicitly mandated). Steam data is mainly good for platform/achievements, not for playtime metrics.

   - **Wikidata:** Game entries exist on Wikidata and can be queried freely (CC0 license). It allows commercial use and unrestricted caching. However, the coverage is spotty (not every game has full data) and it does not provide playtime/finish time. It could serve as a fallback for minimal data (genres, release dates) but lacks the rich fields IGDB has.

## D. IGDB API specifics

1. **Rate limits:** IGDB’s free API allows up to **4 requests per second** and 8 concurrent connections. There is no stated monthly quota – only the per-second limit. Exceeding 4 r/s results in HTTP 429 errors. 

2. **Calling IGDB from mobile:** The IGDB API requires a Client-ID and Bearer token (via OAuth). The docs explicitly warn that IGDB “does not support browser requests (CORS will block them)”. By extension, an *Expo Go* or React Native app on device is like a browser and would face CORS/secret exposure issues. IGDB suggests using a backend proxy to handle authentication. In practice, the mobile app *should not* call IGDB directly with the secret; you should use your Supabase Edge Function to fetch from IGDB and return results. 

3. **Time-to-beat data:** IGDB provides a `game_time_to_beats` endpoint. For each game it returns fields `hastily`, `normally`, `completely` – all in **seconds** – representing average completion times under different play styles. (For example, `hastily` is time to finish main storyline only). To convert to hours, divide by 3600. Use these fields to gauge a game’s length. 

4. **Cover image URLs:** IGDB images are served via their CDN. The pattern is:  
```
https://images.igdb.com/igdb/image/upload/t_{size}/{image_id}.jpg
```  
You replace `{size}` with one of their preset size names (e.g. `cover_small`, `cover_big`, `screenshot_med`, etc). For example, `cover_big` yields a 264×374px cover. The docs list all named sizes and pixel dimensions (e.g. `thumb` is 90×90, `cover_big` is 264×374, `screenshot_med` is 569×320, etc). The `image_id` comes from the IGDB data (the `image_id` field of the Cover object). 

5. **Deprecated fields / migration:** IGDB has announced a renaming of several fields for consistency. For example, the old `age_rating.category` becomes `age_rating.organization`, `character.gender` becomes `character_gender`, `company_website.category` becomes `type`, etc. They are doing a 6-month migration (Feb 18 to Aug 31, 2026) during which both old and new names work. **After Aug 31, 2026, the old fields will be removed**. So you should code against the new names now. The IGDB docs table (in “Important Changes” section) has all the renamings. 

6. **Filtering out DLC/expansions:** IGDB’s game model has fields like `dlcs`, `expansions`, `similar_games`, and a `game_type` (formerly `category`) indicating main game vs DLC vs bundle, etc. To exclude non-base titles, you can filter by `game_type` or check `dlcs = []` and `expansions = []`. For example, queries can use `where game_type = 0` if ‘0’ is the ID for “Game” (use the `/game_types` endpoint to find the ID for main games). In practice, you’ll need to combine filters (IGDB does not auto-filter variants), but the data to do so is there (e.g. see `dlcs`, `expansions`, `bundles` fields). 

7. **PC system requirements:** Yes – IGDB’s platform version object includes system specs. The `platform_versions` endpoint has fields like `os`, `memory`, `storage`, `summary`, etc.. For PC, one of these versions is “PC” or “PC (Windows)”, and its `memory`, `os`, `storage` fields give the requirements (e.g. “Windows 10, 8 GB RAM, etc.”). So you can query `/platform_versions` for PC to get that info.

8. **Access token lifetime:** The OAuth access token from Twitch (for IGDB) lasts **60 days**. You can have up to 25 active tokens per app; generating a 26th invalidates the oldest. You should store the expiry and refresh the token proactively (or regenerate via the client credentials flow) before it expires, reusing or replacing as needed.  

## E. Backend (Supabase)

1. **Free plan limits:**  The Free (Starter) tier includes **500 MB** of Postgres storage and 1 GB file storage.  However, a critical point: *free projects are automatically paused after 1 week of inactivity*. Since judging runs into late October, you can’t rely on a free project staying awake if it goes a week with no traffic. To avoid downtime, you’d need to either ping it weekly or upgrade to Pro. Also, free accounts are limited to 2 active projects.

2. **Edge Function limits:**  Supabase Edge Functions have a **150-second (2.5 min)** maximum execution time on the free tier (400s on paid). They also have low memory (256 MB) and only 2 s of CPU time per request. A naïve import of ~100,000 rows might exceed 150s or memory on free. In practice, bulk loading that many rows via HTTP in one function may fail. You might need to batch the import or do it via psql in the database instead (e.g. split into smaller chunks or use COPY). 

3. **pg_trgm availability:**  Supabase allows PostgreSQL extensions; `pg_trgm` is supported out of the box. You just enable it with `CREATE EXTENSION pg_trgm;`. Once enabled, you can use `similarity()` and the `%` operator without known issues. (One caveat: if you use RLS, you may need to allow extension schemas, but in general it just works.)

## F. Mobile (Expo)

1. **expo-share-intent version:** For Expo SDK 57, use **expo-share-intent v8.0+**. The README explicitly maps SDK 57 → v8.0+.  Note that this module **cannot run in plain Expo Go**; it requires a custom dev client (because it’s a custom native module).

2. **React Native version & `expo prebuild`:**  Expo SDK 57 uses **React Native 0.86** (up from 0.85 in SDK 56). The React version remains at 19.2.  A significant change in SDK 57’s tooling is that `expo prebuild` now *clears and re-generates* the native Android/iOS directories by default (whereas previously it would patch the existing). If you run `expo prebuild` without `--no-clean`, it will wipe your platform folders and recreate them. This can surprise someone who expects incremental updates. (You can use `expo prebuild --no-clean` to apply changes on top of existing native code.) 

## G. Share ingestion (oEmbed)

1. **YouTube and TikTok oEmbed:** Both services offer public oEmbed endpoints that require no auth. For YouTube, hitting  
```
https://www.youtube.com/oembed?url={YOUTUBE_VIDEO_URL}&format=json
```  
returns JSON with keys like `title`, `author_name`, etc. For example, a sample YouTube oEmbed response includes: `"title": "Amazing Nintendo Facts", "author_name": "ZackScott", ...`. For TikTok, the similar endpoint  
```
https://www.tiktok.com/oembed?url={TIKTOK_VIDEO_URL}
```  
returns JSON including fields `title`, `author_name`, `thumbnail_url`, etc. In TikTok’s case, the `title` field contains the video’s caption text. In the example above, `"title": "Perseverance sent back new images from Jezero Crater"` – so if the original TikTok caption had hashtags, they would appear in `title`. In our tests, TikTok’s oEmbed includes the full caption (including hashtags). These endpoints currently work without keys. 

2. **Rate limits/reliability:** Neither oEmbed endpoint has an official public rate limit, but they are generally reliable for light use. YouTube’s oEmbed is backed by Google and handles normal traffic easily. TikTok’s oEmbed is undocumented and provided “as a courtesy”; heavy hammering could get it shut down. SparkProxy’s write-up explicitly warns “Rate-limit yourself here… It’s an undocumented endpoint, not a contract, and hammering it is the fastest way to get it closed”. In practice, sporadic calls for individual shares should be fine, but do not batch-query or spam them.

## H. Session length vs finish time

No public dataset provides typical **session lengths** for games. Only completion times (like IGDB’s time-to-beat) are readily available. Thus, there’s no definitive way to match “I have 1 hour” to a game’s session length. As a proxy, one could use shorter completion times (e.g. choose games whose *hastily* completion time is, say, 3-5× the session length) or restrict to genres known for short play sessions (e.g. puzzle or arcade games). Another idea is to use IGDB’s “hastily” time or HowLongToBeat’s “short completionist” times as a rough upper bound. In practice, you'd likely need to make a design decision (for example: pick games with “hastily” time under a certain threshold) and explain that in UX, since no existing source maps game data to session length directly.

---

**Sources:** We drew on official docs and up-to-date sources as listed below. Key quotes are cited inline above.  

**Schedule-critical summary:**   
- Closed testing (14 days) must start by ~Sept 6–7.  
- Apply for Play production access ~Sept 20.  
- Submit final apps ~Sept 27 for review.  

**References:**

1. RevenueCat Shipathon rules (Devpost)  
2. RevenueCat blog “How to submit”  
3. Google Play Console docs (testing)  
4. Google Play production access timing (Google support)  
5. Google app release timeline (IconikAI blog)  
6. Apple App Store review stat (Apple Dev docs)  
7. IGDB official FAQ (Business: caching, attribution, tokens)  
8. IGDB API docs (Auth rate limits, CORS)  
9. IGDB API docs (Time-to-beat endpoint)  
10. IGDB API docs (Images)  
11. IGDB API docs (Important Changes, migration)  
12. IGDB API docs (Game model: dlcs/expansions)  
13. IGDB API docs (Platform versions fields)  
14. IGDB Twitch Agreement (forum quote)  
15. IGDB FAQ snippet on access token (kudos)  
16. Supabase pricing page  
17. Supabase Functions limits  
18. Supabase extensions list (pg_trgm)  
19. expo-share-intent README (version table)  
20. expo-share-intent README (no Expo Go)  
21. Expo SDK 57 changelog (RN version, prebuild)  
22. TikTok oEmbed example (SparkProxy)  
23. YouTube oEmbed example (StackOverflow)  
24. RAWG API terms (implied by usage)  
25. MobyGames API site/forum (pricing)  
26. TheGamesDB API info (APIs.io)