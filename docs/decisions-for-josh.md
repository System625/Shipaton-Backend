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



---

## 15 Sep 2026 — the search message, and Josh's reply

The message we sent him (abridged) made three asks: two API keys (Voyage for
embeddings, Anthropic for enrichment), a yes/no on the re-release catalog fix, and
a call on how much of vague search to build before the deadline — proposing the
2-day cut-down version now and a decision on the remaining 3 days once the core
loop is closed.

**He agreed to asks 2 and 3.** Catalog fix is a go; build the 2-day version now.

### 3. DeepSeek key, in place of the Anthropic key

**Received 15 Sep 2026. Key moved to `.env` as `DEEPSEEK_API_KEY`** — it is not
kept in this file, which is tracked in git. Verified live the same day: the key
works, balance $36.98, models `deepseek-flash` and `deepseek-v4-pro`, OpenAI-shaped
API at `https://api.deepseek.com`.

**The substitution covers what he approved.** The 2-day version is step 3 of
`docs/research/semantic-search.md` §8 — "LLM names the game, grounded through
`shelf_search_games`" — which needs no embeddings and no enrichment, only an LLM.
DeepSeek does that.

**It does not cover step 5.** DeepSeek has no embeddings endpoint — `/embeddings`
returns 404, checked 15 Sep. It cannot stand in for Voyage. The enrichment +
embeddings + HyDE half still needs a Voyage key, which has not been sent. Voyage is
free and the signup is five minutes, so this is not a cost question; it just has to
be asked for again if and when step 5 is greenlit.

**Measured the same day, against `reddit-eval.tsv`** — the 77 real r/tipofmyjoystick
queries, the set we hill-climb against, the one the lexical build scored 0% on:

| Config | reddit @1 | wall/query |
|---|---:|---:|
| lexical FTS baseline (11 Sep) | **0%** | ~0 |
| `deepseek-flash`, thinking OFF | 7.8% | 0.2s |
| `deepseek-flash`, `reasoning_effort=minimal` | 40.3% | ~23s |
| `deepseek-flash`, thinking ON | **42.9%** | ~29s |

That is raw model knowledge with **no catalog grounding yet** — step 3 grounds
through `shelf_search_games`, which is already live with its full filter signature.
Cost measured at **$0.71 for ~300 queries**, about 0.7 cents each.

**Three gotchas that must travel with those numbers:**

1. **The reasoning is the capability.** With thinking disabled the model answers
   `UNKNOWN` on 69 of 77. There is no cheap fast path.
2. **Latency is the real constraint, not accuracy.** ~23-30s per query. §7 of the
   research doc assumed "a second of latency is acceptable if the UI admits it";
   that does not survive contact. The instant trigram path underneath becomes
   load-bearing and the vague answer has to arrive asynchronously.
3. **A small `max_tokens` silently returns an empty string** with `finish_reason:
   "length"` — no error. The first run here scored 27.3% purely from truncation.

### His question: "when you say local only, do you mean mock?"

Neither. That line was stale when we sent it — it described the state before
12 Sep, and library sync shipped that day (commit `cfa0909`). Sola's endpoints are
real and writes land on the live database. Verified 15 Sep:

| | |
|---|---:|
| `library_entries` rows | 9 |
| …from the Steam import | 6 |
| …from share ingestion (search / youtube) | 3 |
| distinct users holding them | **1** |
| `auth.users` | 2 |
| `profiles` | 1 |
| linked platform accounts | 1 |

So the loop is closed, and it is closed for exactly one account — `solaakintewe`.
The second signup (14 Sep 22:52) is `testuser123@gmail.com`, unconfirmed: a test or
bot signup, not a real user who fell out of the funnel. Nothing to fix there.

**What stands is the real point:** nothing multi-user has ever been exercised. One
account holds every library row in the system. Worth knowing before we assume the
loop is proven — RLS was verified with two accounts back on 7 Sep, but no second
account has used the app end-to-end since the endpoints went live.

---

## Reply to send Josh

> On the key — it works, and it covers the version you greenlit. I measured it the
> same day rather than assume.
>
> On the 77 real "tip of my joystick" queries, the set where our existing search
> scores **0%**, DeepSeek gets **42.9%** — and that's before it's wired to our
> catalog, which should push it up. So the approach is confirmed: the content was
> never the problem, the matching method was. Cost is about 0.7 cents a search.
>
> Two things you should know, one good, one awkward.
>
> **The good:** the 2-day version needs nothing else. It's an LLM naming the game
> and our existing search confirming it, no embeddings involved. Your key is
> sufficient and I'm building it.
>
> **The awkward:** DeepSeek has no embeddings endpoint at all — I checked, it 404s.
> So it can't stand in for Voyage if we ever green-light the bigger 3-day version.
> Voyage is free and the signup is five minutes, so this isn't a cost thing, I just
> need you to do it if and when we decide to go further. Not now.
>
> The other thing the measurement turned up: it takes 20-30 seconds a query. The
> accuracy is fine, the wait isn't. So the UI shows normal search results instantly
> and the "I think you mean X" answer lands a few seconds later. It changes the
> screen design, not the plan.
>
> **On "local only" — you're right and I was wrong.** That line was stale when I
> sent it; it described where we were before the 12th, and library sync shipped
> that day. Sola's endpoints are real and writes land on the live database. I
> checked this morning: 9 library rows, 6 from the Steam import, 3 from share
> ingestion.
>
> But all 9 belong to one account — Sola's. The only other signup is a test address.
> So the loop is closed and proven for one person, and nothing multi-user has been
> exercised since the endpoints went live. Worth getting two or three real people
> through it this week.
>
> Catalog fix is a go, starting it — RE2 is still 1998, RE4 still 2005, Mario
> Kart 8 with no Deluxe, no Persona 5 Royal, all confirmed still true.
