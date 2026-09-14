1. Your Steam Web API Key

**Received 14 Sep 2026. Key moved to `.env` as `STEAM_WEB_API_KEY`** — it is not
kept in this file, which is tracked in git. Registered to the domain
`getshelv.app` (`STEAM_API_DOMAIN`).

2. OpenXBL public key

**Received 14 Sep 2026. Moved to `.env` as `OPENXBL_API_KEY`**, same reason.

> Both keys are server-side only and must never ship in the app bundle. `.env` is
> gitignored; `.env.example` carries the empty placeholders and the notes. They
> still need to be set as Supabase secrets before any edge function can read them.

We'll keep $150/hr

Account linking:
Xbox: yes, you can join

The memo's premise is right — IGDB stores the Store product ID (9NDXJG3LSP32) and Xbox Live returns a decimal title ID (1777860928). Different namespaces. But the conclusion, "no lookup table at any price," is just not true. Microsoft publishes the bridge.

Microsoft's own support guidance tells people to hit displaycatalog.mp.microsoft.com/v7.0/products?bigIds=<productID> and read XboxTitleId out of the response. The freshdex Xbox tracker does exactly this in production, pulling xboxTitleId from the catalog's AlternateIds array to backfill title IDs. And the endpoint supports reverse lookups by alternate ID — the documented pattern is products/lookup?market=US&languages=en-US&alternateId=PackageFamilyName&value=<PFN>, and XboxTitleId is an alternate ID type.

So the join is:

IGDB external_games (microsoft) → bigId
      ↓  DisplayCatalog, batched
XboxTitleId (decimal)
      ↓  exact match
OpenXBL titleHistory titleId

And this is a build-once batch job, not a per-user call. Take every IGDB game with a microsoft external ID, page through DisplayCatalog with bigIds= comma-batched, store titleId → igdb_id. A few hours of compute, then imports are a hash lookup forever.

Three real caveats, none fatal:

DisplayCatalog is unofficial and Microsoft says it can change. So is OpenXBL, which you're already depending on. Same risk class, no new exposure.
It's many-to-many. One bigId can carry several title IDs across 360/One/Series, and editions and regions produce multiple bigIds per game. Don't force a unique constraint — store the edges, resolve to the IGDB parent.
PC-only Store products won't have an XboxTitleId at all. Fine, they won't appear in Xbox Live title history either.

Xbox moves from "build fourth, match on name" to "build second, deterministic." The actual limiter isn't the join, it's how many IGDB games carry a microsoft external ID in the first place — measure that before you re-rank the order. That's the number the memo should have reported and didn't.


Three answers.

Xbox — go, and it jumps ahead of PSN

One extra thing to do before Posi starts: run the batch job first and measure it. Pull every IGDB game with a microsoft external ID, page through DisplayCatalog, count how many actually return an XboxTitleId. That number tells you your Xbox ceiling. If it's above 70% you're in good shape; below 50% and you're back to name matching as the primary path rather than the fallback. Either way you know before you build the UI, and the job is a few hours.

Do it as a build-time artifact checked into the repo, not a runtime dependency. If DisplayCatalog changes or rate-limits you mid-hackathon, your map still works.

Android — here's the actual build

Four steps, roughly a day total.

1. Build the manifest list from IGDB, not from a generic top-games list.

This is the part that makes the 17% number stop mattering. You control what goes in <queries>, so build it as: top mobile games by installs, cross-referenced against IGDB's android external IDs. Where IGDB has the package, you get cover art and metadata free. Where it doesn't, you still include the package — it just renders locally. Keep it around 500 entries; the manifest is parsed at install time and you don't want to bloat it.

2. Detect.

Loop the list, getPackageInfo on each, no permission required. For every hit you get from ApplicationInfo: the app label, the icon, firstInstallTime, lastUpdateTime, and the category flag.

3. Render everything, resolve what you can.

package found
  ├─ in IGDB  → cover art, release date, genres, full game row
  └─ not      → device label + device icon, flagged local_only

An unmatched game still gets a row, a status, and a place in the library. It just has a launcher icon instead of box art. Nobody will care. Hiding it is what would look broken.

4. Usage stats, opt-in, after they've used the app.

PACKAGE_USAGE_STATS is granted in system settings, not a runtime dialog, so it needs an in-app explainer screen before you fire the intent. Read only the packages you already matched. Never gate anything behind it.

That gives you "we found 14 games on your phone, and you've put 40 hours into Clash Royale this month." No competitor has either half.

One thing to be deliberate about: this is your Galaxy Store pitch. Samsung isn't going to feature you for a foldable layout alone — every entrant will have one. "The only game tracker that sees the games on your phone" is an actual reason.

PlayStation — buildable, just last

I wasn't saying skip it. I was saying the join is name-based and the data is trophies, not ownership.

What you get: getUserTitles returns trophy titles with clean retail names and completion percentages. Name-match those against IGDB with normalization — strip trademark symbols, edition suffixes, platform tags, trailing subtitles — and you'll land most of a popularity-weighted library. The tail misses, and the manual-fix bucket catches those.

Two things to be honest about in the UI, because users will otherwise think you're broken:

It shows games you've earned trophies in, not games you own. Installed-and-never-played won't appear.
The PS4 and PS5 versions of a game are separate trophy sets. Dedupe against the IGDB parent or people see doubles.

The real reason it goes last isn't the matching — it's the NPSSO. Leaving the app, signing into Sony in a browser, finding a 64-character string in raw JSON, copying it without the quotes, coming back. On a phone. Then again in two months. That flow will have terrible completion rates no matter how well you build it.

Ship it behind an "Advanced" disclosure with clipboard detection when the user returns, and immediate validation so a bad paste fails in a second. And exchange the NPSSO for tokens in the same request — never store it.


