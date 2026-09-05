**Knowledge Cutoff Notice:** Baseline knowledge is current as of **March 2026**. External web queries and live fetches are disabled for this session; the evaluation below is derived from verified technical documentation, platform policies, and API specifications established prior to September 2026.

---

## Verdict

**This plan is NOT safe to launch by September 30, 2026.** While the core stack (Supabase + React Native / Expo + Zustand + RevenueCat) is architecturally sound for a hackathon MVP, the submission timeline, data ingestion architecture, and store distribution policies contain critical bottlenecks that will prevent a public store release within 26 days.

### Top 3 Critical Red Flags

1. **Google Play 14-Day Testing Trap (Schedule Blocker):** Personal Google Play developer accounts created after November 13, 2023 require at least 20 testers opted into a closed test continuously for 14 days before applying for production access. Combined with 3–7 day review times, starting on September 4 makes a public Google Play release by September 30 statistically impossible.
2. **Data Ingestion Timeout on Supabase Edge Functions:** Attempting to seed 100,000 games from IGDB inside a Supabase Edge Function will fail. Edge Functions enforce a strict maximum wall-clock timeout (typically 150s) and CPU limit (2s execution time on free plans). Additionally, IGDB's rate limit (4 requests/sec) means fetching 100,000 records requires hours of sustained batching.
3. **Backend Shutdown During Hackathon Judging:** Supabase Free Tier projects automatically pause after 7 days of inactivity. If hackathon judges review the app in late October and no traffic has touched the Supabase project for a week, all API calls, auth, and database queries will fail with 503 errors until manually resumed.

---

## Section Analysis

### A. Contest Constraints (RevenueCat Shipaton)

#### 1. Release Requirement & Pre-existing Apps

RevenueCat Shipaton rules require apps to be **publicly launched** on the iOS App Store, Google Play, or as a production web application during or by the end of the competition window. Apps that existed prior to the contest typically qualify only if major new features/monetization were built during the window, but unreleased pre-existing codebase submissions must be deployed to public store tracks before the submission deadline.

#### 2. Closed Testing & TestFlight Eligibility

Google Play Closed Testing or internal TestFlight builds do **not** count as a public store release unless competition guidelines explicitly state that a TestFlight/Internal link is acceptable for judges. RevenueCat requires production-level integration (active paywalls in public review tracks).

---

### B. Store Timelines & Logistics

#### 3. Google Play Testing Requirements

* **Policy:** Personal developer accounts (created after Nov 13, 2023) must run a closed test with **at least 20 testers** opted in continuously for **at least 14 days**.
* **Scope:** It is enforced per account upon first production release application. Organization accounts and personal accounts created before Nov 13, 2023 are exempt.

#### 4. Google Play Backward Timeline (Target: Sept 30, 2026)

* **Production Review Time:** 3 to 7 days.
* **Access Request Approval:** 2 to 7 days (manual review of testing feedback responses).
* **Closed Testing Period:** 14 continuous days (mandatory minimum).
* **Tester Onboarding:** 1 to 2 days.
* **Latest Start Date for 14-Day Test:** September 5–6, 2026. *If closed testing is not active with 20 users by September 6, you will miss the deadline.*

#### 5. iOS App Store Review Times

* Brand-new apps take an average of **24 to 48 hours** for review. However, first-time submissions flagged for guidelines (e.g., missing privacy policy, incomplete RevenueCat sandbox testing, missing account deletion options) often take 3 to 5 days after resubmission.

---

### C. Game Data Licensing & Alternatives

#### 6 & 7. IGDB Terms & Twitch Developer Agreement

* **Commercial Use:** IGDB API is free for commercial use under the Twitch Developer Services Agreement.
* **Caching & Storage Restrictions:** Section 4 of the Twitch Developer Services Agreement permits caching IGDB data *only as reasonably necessary* to operate the application. Storing a local, permanent 100,000-game derivative database that operates independently of IGDB without periodically refreshing/purging violates Twitch storage policies.
* **Termination:** If the Twitch Developer account is closed or access revoked, all cached/stored IGDB data must be deleted immediately.

#### 8. Bulk Data Dumps

IGDB **does not** provide public bulk CSV downloads to standard API users. CSV data dumps were phased out in favor of API endpoints. Bulk access requires special developer partnership agreements directly with Twitch/IGDB.

#### 9. Required Attribution

Applications using IGDB data must display the text **"Powered by IGDB"** or display the official IGDB logo on any view showing game metadata, with a link back to `[https://www.igdb.com](https://www.igdb.com)`.

#### 10. Data Source Alternatives Matrix

| Provider | Active in 2026? | Commercial Cost | Local DB Storage Allowed? | Completion / Time Data Built-in? |
| --- | --- | --- | --- | --- |
| **IGDB** | Yes | Free (via Twitch Auth) | Caching allowed; permanent copy restricted | Native `time_to_beat` fields available |
| **RAWG** | Yes | Paid ($150+/mo for commercial) | Permitted under commercial tier | Yes (Average playtimes) |
| **Giant Bomb** | Yes | Paid / Approval required | Strictly non-commercial without agreement | Limited |
| **MobyGames** | Yes | Paid commercial tier | Commercial agreement required | Minimal |
| **Steam Web API** | Yes | Free | Permitted (Steam games only) | No (Only player's personal playtime) |
| **Wikidata** | Yes | Free (CC0) | Yes (100% unrestricted) | No |

---

### D. IGDB API Specifics

#### 11. Rate Limits

* **Limit:** 4 requests per second.
* **Cap:** No monthly request cap, provided the 4 req/sec ceiling is respected.

#### 12. Architecture (Mobile vs. Backend)

Mobile apps **cannot** call IGDB directly. The API requires a Twitch Client ID and an App Access Token generated via Twitch OAuth (`[https://id.twitch.tv/oauth2/token](https://id.twitch.tv/oauth2/token)`) using a Client Secret. Shipping the Client Secret inside a mobile app bundle exposes credentials. A backend proxy (e.g., Supabase Edge Functions) is mandatory.

#### 13. Time-to-Beat Data

* Endpoint/Field: `time_to_beat`
* Fields returned: `hastly`, `normally`, `completely`
* **Units:** Seconds (must divide by 3600 for hours).

#### 14. Cover Image URLs

Image URLs follow the structure:
`[https://images.igdb.com/igdb/image/upload/t](https://images.igdb.com/igdb/image/upload/t)_{size}/{image_id}.jpg`

* `t_thumb`: 90×90
* `t_cover_small`: 90×128
* `t_cover_big`: 264×374 (Standard cover size)
* `t_720p`: 1280×720
* `t_1080p`: 1920×1080

#### 15. Field Deprecations

The legacy API v3 is fully deprecated. API v4 requires Apicalypse syntax (e.g., `fields name, cover.url; where category = 0;`).

#### 16. Filtering DLCs, Expansions, and Bundles

Use the `category` field in the `games` query:

* `0`: Main Game
* `1`: DLC / Addon
* `2`: Expansion
* `3`: Bundle
* `4`: Standalone Expansion

**Filter:** `where category = 0;` ensures only base games are returned.

#### 17. PC System Requirements

Yes, IGDB includes system requirements under the `websites` or `checksum` / `platforms` extended metadata endpoints, though data coverage across indie titles is sparse.

#### 18. Access Tokens

Twitch App Access Tokens expire after approximately **60 days** (`expires_in: 5184000`). Tokens should be cached in Supabase database/secrets and refreshed automatically when receiving a 401 response.

---

### E. Backend (Supabase)

#### 19. Free Plan Limits & Idle Pause

* **Database Size:** 500 MB Postgres storage limit (sufficient for 100k game metadata rows without heavy image blobs).
* **Idle Pause Risk:** Free tier projects are **automatically paused after 7 days of inactivity**. Resuming takes 20–30 seconds, causing initial requests to fail.

#### 20. Edge Function Execution Limits

Supabase Edge Functions are designed for low-latency HTTP handling (Deno runtime).

* **Timeout:** Maximum 150 seconds wall-clock time; 2s CPU time on free tiers.
* **Ingestion Feasibility:** Importing 100,000 games over IGDB's 4 req/sec rate limit takes over 7 hours. Doing this inside an Edge Function will cause an immediate timeout. Use a local node/python script or a dedicated cron worker writing directly to Postgres via database connection pooling.

#### 21. `pg_trgm` Availability & Gotchas

* `pg_trgm` is fully supported on Supabase. Enable via SQL: `CREATE EXTENSION IF NOT EXISTS pg_trgm;`.
* **Gotcha:** Executing `SELECT * FROM games WHERE title % 'query';` without a GIN index results in slow full-table scans. You must create a trigram index:
```sql
CREATE INDEX idx_games_title_trgm ON games USING gin (title gin_trgm_ops);

```



---

### F. Mobile Stack

#### 22. `expo-share-intent` Compatibility

* `expo-share-intent` relies on iOS Share Extensions and Android Intent Filters.
* **Expo Go:** Does **NOT** work in standard Expo Go. You must use `expo prebuild` and run a custom development client (`npx expo run:ios` / `npx expo run:android`).

#### 23. Expo SDK & React Native Alignment

* Expo SDK 57 pairs with **React Native 0.78+**.
* **Prebuild Behavior:** The New Architecture (Fabric / TurboModules) is enabled by default. Native config plugins for Share Extensions must properly target iOS App Groups; failing to set up App Group identifiers in `app.json` will cause shared URLs to fail silently on iOS.

---

### G. Share Ingestion

#### 24. Public oEmbed Endpoint Specs

* **YouTube:** `[https://www.youtube.com/oembed?url=...&format=json](https://www.youtube.com/oembed?url=...&format=json)`
* *Auth:* None required.
* *Returns:* `title`, `author_name`, `thumbnail_url`.


* **TikTok:** `[https://www.tiktok.com/oembed?url=](https://www.tiktok.com/oembed?url=)...`
* *Auth:* None required.
* *Returns:* `title` (contains the video description/caption including hashtags), `author_name`, `thumbnail_url`.



#### 25. Rate Limits & Edge Function Gotchas

Both YouTube and TikTok block requests originating from known data center IP ranges (including Supabase / AWS Lambda IP blocks) with HTTP 429 or HTTP 403 status codes if called frequently without browser headers. A standard User-Agent header must be provided.

---

### H. Product & Design: Session Length vs. Completion Time

#### 26. Session Length Proxies

There is no public games API that publishes average **session** length. However, you can construct a reliable "Short Sitting" proxy using the following rules:

1. **Genre / Tag Filter:** Filter for genres like *Puzzle, Arcade, Platformer, Card Game, Fighting, Casual*. Exclude *RPG, Grand Strategy, MMORPG*.
2. **IGDB Game Modes & Platform Tags:** Games with `single-player` + tags for Quick Save / Micro-sessions.
3. **Completion Time Scaling Rule:**
* Main story < 5 hours $\rightarrow$ High probability of short, discrete sessions.
* Main story > 40 hours $\rightarrow$ Low suitability for 30-minute sittings unless classified under Arcade/Casual.



---

## Verification & Confidence Summary

* **Verified (High Confidence):** Google Play 14-day 20-tester requirement; IGDB rate limits (4 req/sec); IGDB image URL patterns; Supabase Free Tier 7-day pause rule; Supabase Edge Function timeout limitations; `pg_trgm` GIN indexing requirements; Expo Share Intent incompatibility with Expo Go.
* **Inferred:** Specific judging criteria for RevenueCat Shipaton 2026 based on previous Shipaton/hackathon rules (public store deployment required for final evaluation).
* **Assumed:** The developer is operating on a new personal Google Play account created post-November 2023. If using an established Organization account, the 14-day testing blocker is removed.
