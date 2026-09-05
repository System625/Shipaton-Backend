# Research prompt: verify the technical plan for a game backlog app

Copy everything below the line into a fresh chat with a research-capable model.

---

You are a research agent. Research every claim on the web before answering. Do not answer from internal knowledge, however simple a question looks. Assume your training data is stale: vendor terms, pricing, API fields and store policies change, and a confident memory of them is the most likely thing you will get wrong.

**Today is 4 September 2026.** State your knowledge cutoff at the top of your answer so I know how much of this you could not have known.

## Method

1. **Search** for one fact per query. Focused questions, not keyword dumps. Do not append the year to queries; use `after:YYYY-MM-DD`, `site:` and quotes instead.
2. **Fetch and read pages in full.** Search snippets are not evidence and do not count. Read the vendor's own documentation, terms and pricing pages, not blog posts or forum threads about them.
3. If a page is blocked by Cloudflare, a 403 or a CAPTCHA, **say so explicitly** rather than substituting a secondary source. Do not solve CAPTCHAs.
4. Check publication dates. A forum answer from 2020 is not evidence about 2026 terms.
5. **Quote verbatim**, briefly, with the URL, wherever exact wording carries the meaning. Terms, pricing and policy especially.
6. Separate explicitly what you **verified**, what you **inferred**, and what you are **assuming**. Flag anything below roughly 95% confidence as uncertain. Where sources disagree, present the disagreement rather than picking a winner.

Do not tell me the plan is fine. I want the things that are wrong.

## The project

**Shelf** is a video game backlog tracker, built by three people for a hackathon, due **30 September 2026**. React Native and Expo SDK 57, TypeScript, Zustand for state. It has a paid tier through RevenueCat, so it is a monetized product from day one.

Three features, and nothing else:

1. **Share ingestion.** You see a game on TikTok or YouTube, hit the OS share sheet, and it lands in your backlog with the source link attached. We resolve the shared URL through the public oEmbed endpoints to get a title or caption, extract a probable game name, match it against our catalog, and show a confirm screen before adding anything.
2. **A roulette.** You tell the app how much time you have and what platform you are on, and it picks something from your backlog.
3. **A finish card.** You complete a game, rate it, and get a shareable image.

**Proposed stack, which is what I want checked:**

- **Game data:** IGDB, accessed through the API with Twitch credentials. We plan to seed a Postgres catalog of roughly 100,000 games and serve our users from our own copy, refreshing periodically, rather than calling IGDB per request.
- **Backend:** Supabase. Postgres for the catalog, built-in auth, Edge Functions holding the IGDB credentials so they never ship in the app bundle, and `pg_trgm` trigram similarity for fuzzy title matching.
- **Share intent:** the `expo-share-intent` library, which requires `expo prebuild` and a custom dev client.
- **Stores:** iOS App Store and Google Play.

## What I need you to verify

Treat each of these as an open question. I have not told you my own findings, deliberately, because I want your independent answer rather than agreement with mine.

### A. Contest constraints

1. What are the RevenueCat Shipaton 2026 rules on when an app must be released, and does an app that exists but was never publicly released before the window still qualify? Quote the rule.
2. Does an app in Google Play closed testing, or in TestFlight, count as released for a contest that requires judges to download it?

### B. Getting onto the stores in time

3. What are Google Play's current testing requirements for new apps from personal developer accounts? How many testers, for how long, which accounts are exempt, and is it per app or per account?
4. After closed testing completes, how long does Google take to grant production access, and how long does the subsequent app review take? **Work backwards from 30 September 2026 and tell me the latest date each step could start.**
5. What are realistic App Store review times for a brand new app in 2026?

### C. Game data licensing, which is the part I most want challenged

6. What exactly do IGDB's terms permit? Specifically: is commercial use allowed, what does it cost, is a partnership required, what does the partnership require of us, and what happens to data we have stored if the relationship ends?
7. IGDB's documentation points at the Twitch Developer Services Agreement. **Read that agreement.** Does anything in it restrict storing or caching third-party data, and if so does that conflict with what IGDB's own FAQ says about caching? This is the specific thing I want a second opinion on.
8. Are IGDB's bulk CSV data dumps available to everyone or only to partners?
9. What attribution does IGDB require, and where must it appear?
10. **What are the actual alternatives in 2026?** Check the current status of RAWG, Giant Bomb, MobyGames, TheGamesDB, Steam's Web API and Wikidata. For each: is the API still operating, what does commercial use cost, does it permit storing data on our servers, and does it publish how long a game takes to finish? Do not rely on comparison articles, check each provider's own pages, and tell me if any of them has shut down or changed pricing recently.

### D. IGDB API specifics

11. What are the rate limits, and is there any monthly request cap?
12. Can the mobile app call IGDB directly, or is a backend proxy required?
13. How do you get time-to-beat data, what fields does it return, and **what units**?
14. How are cover image URLs constructed, what sizes exist, and what are their pixel dimensions?
15. Has IGDB deprecated or renamed any fields recently, and is there a migration deadline that has already passed?
16. Searching a games API for a popular title tends to return DLC, expansions, bundles and special editions alongside the base game. What does IGDB provide for filtering those out?
17. Does IGDB publish PC system requirements?
18. How long do the access tokens last, and how should token refresh be handled?

### E. Backend

19. What are Supabase's current free plan limits: database size, and specifically **does anything happen to an idle project**? Judging runs into late October, so the backend must stay up.
20. What are the execution limits on Supabase Edge Functions? I want to know whether a bulk import of ~100,000 rows can run inside one.
21. Is `pg_trgm` available on Supabase, and are there any known gotchas in getting `similarity()` and the `%` operator working there?

### F. Mobile

22. Which version of `expo-share-intent` supports Expo SDK 57, and does it work with Expo Go?
23. What is Expo SDK 57's React Native version, and are there behaviour changes in `expo prebuild` that would surprise someone upgrading?

### G. Share ingestion

24. Are YouTube's and TikTok's public oEmbed endpoints currently working without authentication? **Actually call them if you can.** What does each return for a typical video, and does TikTok return the full caption including hashtags?
25. Are there rate limits or reliability problems with either that would affect a production app?

### H. One design question

26. Users tell the app "I have about an hour". Games databases publish how long a game takes to **finish**, which is a different quantity on a different scale. Is there any data source that publishes typical **session** length rather than completion time? If not, what is the best available proxy for whether a game suits a short sitting?

## Output

Lead with a short **Verdict** section: is this plan safe to build on, and what are the three most serious problems with it.

Then work through the sections above. For each claim, say whether it is confirmed, wrong, or unverifiable, and give the quote and URL that settles it. Group anything that is schedule-critical separately, since the deadline is fixed and 26 days away.

End with a numbered source list of pages you actually fetched and read in full. Do not include pages you only saw as search results.
