# Account linking — Steam, PlayStation, Xbox, Nintendo

**Researched 12 September 2026.** Every number below was measured against the live
IGDB API and our own catalog on that date, not taken from a blog post. The scripts
are in the appendix so you can re-run them.

Josh's thread with Claude (shared 12 Sep) settled the *product* question — imports
are worth building, Steam first, PSN last, Nintendo never. This document answers the
question that thread did not reach: **what the backend actually has to do**, and
whether it works. It does, mostly, and the failure modes are now measured rather
than guessed.

---

## 0. The short version

**A Steam import resolves 83–85% of the games a user actually plays, and only 38.6%
of everything they own.** Those are the same import; the gap between them is the
whole story and it is not what section 1 predicted.

> **Measured 14 Sep 2026 against a real 4,652-game library** (`npm run
> lab:steam-library st4ck`), replacing the SteamSpy proxy that produced the 87.8%
> figure this section used to lead with:
>
> | subset | resolved |
> |---|---|
> | everything owned | 1,797 / 4,652 = **38.6%** |
> | ever played at all | 123 / 148 = **83.1%** |
> | played over an hour | 73 / 88 = 83.0% |
> | top 50 by playtime | 42 / 50 = 84.0% |
> | top 20 by playtime | 17 / 20 = 85.0% |
>
> **Owned and cared-about are wildly different sets on Steam.** Bundles, free
> weekends and giveaways put thousands of apps in a library nobody has opened —
> this account has played 148 of its 4,652 games. The unresolved tail is almost
> entirely 2007-era casual shovelware (`Iggle Pop! Deluxe`, `Typer Shark! Deluxe`,
> `Gumboy: Crazy Adventures`), which is exactly what our seed filter is *supposed*
> to exclude.
>
> Note how flat the played-subset figure is: 83.1% over everything ever launched,
> 85.0% over the twenty games they play most. Resolution does not degrade as you
> move down someone's real library, it degrades as you move into the part of it
> they have never touched.
>
> **Neither bound is a typical user.** SteamSpy's top 2,000 was optimistic by
> construction; a 4,652-game collector is pessimistic by construction. A normal
> 50–200 game library sits between them and much closer to the played figure. The
> honest claim to make in the UI is about *played* games, not owned ones.

**The parent hop is worth about 6 points of that**, and the decision behind it is
whether to follow IGDB's `parent_game` link when the exact Steam app is an edition,
remaster or bundle we deliberately excluded from the seed. Follow it, and "Skyrim
Special Edition" lands on Skyrim — verified end to end 14 Sep, both appids collapse
onto one catalog row. On the real library the hop moved 32.8% → 38.6% overall, and
the seeded map carries **12,657 parent-hop edges** out of 78,273.

**Steam is the only platform whose IDs join to ours *directly*.** IGDB stores the
Steam appid verbatim, so a Steam library is a single SQL join. Xbox and PlayStation
both hand back identifiers from a namespace IGDB does not carry, so those two
imports go through title-name matching, which is the machinery we already built for
share ingestion.

> **Corrected 14 Sep 2026.** This paragraph used to say "there is no lookup table to
> build, at any price". That was wrong for Xbox, Josh said so, and the measurement
> agrees with him: Microsoft's DisplayCatalog bridges Store product id → Xbox Live
> title id, and it works on **92.5%** of the ids we hold. What it cannot fix is how
> few of our Xbox games IGDB gives a Microsoft id to in the first place, which caps
> the deterministic route at **55.6%** of our Xbox catalog (62.9% of the rated
> subset, re-measured 15 Sep after the paging fix) against name matching's measured
> 97.0%. So the bridge is real and is worth
> building as a precision layer — it is just not a replacement for the matcher.
> Full numbers in **section 4a**.

**Nintendo is out**, and not for the reason usually given. It is not merely that the
API is private; it is that the private API has no owned-games endpoint at all, so
even paying the ToS and security cost buys you presence and friends, not a library.

**Four things in the current schema will break on the first real import.** They are
small, but two of them fail the way the "Where Winds Meet" bug failed — one bad row
takes a whole batch with it. Section 8.

---

## 1. The headline measurements

### Steam library → our catalog, end to end

SteamSpy's `all` pages are sorted by owner count, so the top 2,000 rows are the
2,000 most-owned apps on Steam — the closest public proxy for what actually sits in
somebody's library. Each appid was pushed through the real pipeline.

| step | result |
|---|---|
| Steam appid → an IGDB game (`external_games`, source 1) | **1,961 / 2,000 = 98.0%** |
| that IGDB game → a row in our 89,123-game catalog | 1,563 / 1,961 = 79.7% |
| **end to end, direct join only** | **1,563 / 2,000 = 78.1%** |
| **end to end, following one `parent_game` hop** | **1,756 / 2,000 = 87.8%** |

> **Superseded 14 Sep by a real library** — see section 0. This table measures the
> 2,000 most-owned apps on Steam, which is a proxy for *popularity*, not for what
> sits in an individual account. Against a real 4,652-game library the same pipeline
> resolves 38.6% of everything owned and 83.1% of everything played. Keep this table
> for the step-by-step breakdown, which still holds; stop quoting 87.8% as the
> import's hit rate.

The 2% that never reach IGDB at all are, correctly, **not games**: Blender, Aseprite,
Wallpaper Engine, Soundpad, Crosshair X, Source Filmmaker, the Black Myth: Wukong
benchmark tool. An import that drops those is behaving properly, not failing. Only a
handful of genuine games are in that bucket (Call of Duty: Modern Warfare 2 (2009),
Civilization IV, Modern Warfare II).

### The 20% gap is our seed filter, not IGDB

Of the 398 IGDB games a Steam library hits that our catalog does not hold:

| IGDB `game_type` | count |
|---|---|
| Main Game | 169 |
| Remaster | 57 |
| Bundle | 47 |
| Expanded Game | 42 |
| Standalone Expansion | 33 |
| Remake | 29 |
| Port | 12 |
| Expansion / Fork / Mod | 9 |

**229 of 398 (58%) are not `game_type = 0`** — exactly the rows the seed excludes on
purpose, and the exclusion is *right* for search (it is why our results do not have
the duplicate-editions problem that is GG's oldest unfixed complaint). It is *wrong*
for an import: somebody who owns DOOM + DOOM II, Deus Ex GOTY, Metro 2033 Redux or
Half-Life 2: Episode One owns a real thing and must see a real row.

The other 167 have fewer than 5 IGDB ratings and fell below `SEED_MIN_POPULARITY` —
old, obscure, mostly bundle-fodder.

**The parent hop fixes 193 of the 398** (218 have a `parent_game` or
`version_parent`; 193 of those parents are already in our catalog). That is the
78.1% → 87.8% jump, and it collapses editions onto their base game, which is the
behaviour we want anyway.

### Where the external IDs exist at all

Coverage of our own catalog, restricted to games with ≥ 5 ratings:

| our subset | source | coverage |
|---|---|---|
| PC (platform 6), 9,454 games | Steam | **7,550 = 79.9%** |
| | GOG | 2,664 = 28.2% |
| | Epic Games Store | 1,578 = 16.7% |
| | Itch | 822 = 8.7% |
| PS4/PS5, 3,703 games | PlayStation Store US | **3,302 = 89.2%** |
| Xbox One / Series, 3,216 games | Microsoft Store | **2,582 = 80.3%** |
| | Xbox Marketplace (360-era) | 185 = 5.8% |
| Android/iOS, 2,171 games | Android (package name) | 368 = 17.0% |
| | Apple (App Store id) | 683 = 31.5% |

Read the PlayStation and Xbox rows carefully. **High coverage there is not useful**,
because the identifier IGDB stores is not the identifier those platforms give us.
See section 2.

---

## 2. The join is the whole problem

This is the part the research thread skipped, and it decides everything else.

`external_game_sources` is a real IGDB endpoint. The full list, pulled live:

```
1 Steam            13 Apple           26 Epic Games Store   36 Playstation Store US
3 GiantBomb        14 Twitch          28 Oculus             37 Focus Entertainment
5 GOG              15 Android         29 Utomik             54 Xbox Game Pass Ultimate Cloud
10 Youtube         20 Amazon          30 Itchio             55 GameJolt
11 Microsoft       22/23 Amazon Luna/ADG  31 Xbox Marketplace   121 IGDB
```

680,836 rows in total; 175,490 of them Steam. Now the UIDs, sampled live:

| source | UID looks like | what the platform's own API returns | joins? |
|---|---|---|---|
| Steam (1) | `271590` | `GetOwnedGames` → `appid` = `271590` | **yes, identical** |
| Android (15) | `com.picsoft.tinydefense` | Android package name | **yes, identical** |
| Apple (13) | `1296181302` | App Store numeric id | yes (no API to read it from) |
| GOG (5) | `1207659220` | GOG product id | yes |
| Epic (26) | `9efde363a6c9497da6888b47ae0c837b` | — (no third-party API) | n/a |
| Itch (30) | `1056926` | itch.io game id | yes |
| Microsoft (11) | `9NDXJG3LSP32` (Store product ID) | OpenXBL → `titleId` = `1777860928` | **no** |
| Xbox Marketplace (31) | `66acd000-77fe-1000-…` (360 GUID) | — | no |
| PS Store US (36) | `228848` (store **concept** id) | psn-api → `npCommunicationId` = `NPWR12345_00` | **no** |

Steam's appid and IGDB's Steam UID are the same number. That is the entire reason
Steam is half a day of work and the others are not.

For Xbox, IGDB carries the **Microsoft Store product ID** — the `9N…` string in a
xbox.com store URL. OpenXBL's title history returns the **Xbox Live title ID**, a
32-bit integer. These are different namespaces, and no source in the list above
carries the Xbox Live title ID.

**But a bridge exists outside IGDB, and it works.** Microsoft's DisplayCatalog
returns `XboxTitleId` in a product's `AlternateIds`, which converts one namespace
into the other as a build-once batch job. Measured in section 4a. The original
claim here — that no lookup table could be built at any price — was wrong, and the
correction is Josh's.

For PlayStation, IGDB carries the **store concept id** (`store.playstation.com/en-us/concept/228848`).
psn-api returns `npCommunicationId` (`NPWR…`, a trophy-set identifier) and CUSA/PPSA
title codes. Also different namespaces, also no join.

**So PlayStation imports must match on the game's display name, and Xbox imports
must do so for the 44.5% of our Xbox catalog the bridge in section 4a cannot
reach.** That is
not a disaster — it is the problem `shelf_match_title()` and `game_alt_titles` were
built for, and the input is far cleaner than a TikTok caption (a store title, not
`#eldenring POV: you died again 💀`). Section 2a has the measured hit rate.

### 2a. Name matching is good enough — and measuring it found a live search bug

`external_games.name` is the **store's own** display string for a product, which is
the same shape of string PSN and Xbox hand back in a title list. So it is a fair
proxy for the real import input, and the IGDB game the row points at is ground truth.
400 names per platform, restricted to targets already in our catalog (otherwise a
miss is a catalog gap, which §1 already measured):

| | rank 1 correct | in top 5 | returned nothing |
|---|---|---|---|
| PlayStation Store names | **394/400 = 98.5%** | 400/400 = 100% | 0 |
| Xbox / Microsoft Store names | **385/400 = 96.3%** | 396/400 = 99.0% | 1 |

Those are the figures **before** the fix below. After it (re-run 12 Sep): Xbox
**388/400 = 97.0%** rank 1 and **398/400 = 99.5%** in top 5; PlayStation unchanged
at 98.5%, as expected — its misses were never edition-related.

That is comfortably good enough to ship, and far better than share ingestion's 14/21
on TikTok captions — as expected, since a store title is clean input.

**But look at what the Xbox misses were.** Three of them:

```
"WWE 2K25 Standard Edition"  ->  Metal Storm      (0.463)
"Avowed Standard Edition"    ->  Metal Storm      (0.490)
"Halo Infinite Standard Edition" -> Halo Infinite (0.452, only just)
```

Two unrelated queries returning *the same wrong game*, and the correct answer not in
the top 5 at all. The cause, confirmed against the live database:

`shelf_match_title()` strips a long list of edition suffixes — `game of the year`,
`goty`, `definitive edition`, `complete edition`, `director's cut`,
`enhanced edition`, `remastered`, `deluxe`, `special edition`, `ultimate edition`,
`anniversary edition` — and **omits `standard edition`**. It has every fancy edition
and not the plain one, which is the single most common suffix stores use, because
`Standard Edition` is what PSN and Xbox append to the *base* version of nearly every
game.

Because the suffix survives normalization, the query becomes a 23-character string of
which 16 characters are `standard edition`. Meanwhile exactly **10 rows out of 62,466
in `game_alt_titles`** happen to end in an edition suffix — and those ten act as
trigram magnets, matching any such query at ~0.4–0.5 while the true title, being
short, scores lower:

```
metal storm standard edition        0.500
endless legend standard edition     0.459
riders republic standard edition    0.436
forza motorsport standard edition   0.415
```

**This is not an import bug. It is live in `/search` today** — any user who types or
pastes a title with "Standard Edition" gets those same ten games. Adding the missing
suffixes to the strip list fixes all three cases outright, verified against the live
database:

| query | before | after |
|---|---|---|
| `Avowed Standard Edition` | Metal Storm (0.490) | **Avowed (1.00)** |
| `WWE 2K25 Standard Edition` | Metal Storm (0.463) | **WWE 2K25 (1.00)** |
| `Halo Infinite Standard Edition` | Halo Infinite (0.452) | **Halo Infinite (1.00)** |

**Applied 12 Sep 2026** —
`supabase/migrations/20260912120000_standard_edition_suffix.sql`. Verified after the
push: 0 stale rows in either table, the spec's GOTY worked example unchanged, and the
Xbox re-run above.

One row survives and is deliberately left alone: `"Patrizier II: Gold-Edition"` →
`patrizier 2 gold edition`. The suffix strip runs *before* punctuation is flattened
to spaces, so a hyphenated German compound never matches the space-separated pattern
— true of the older suffixes too, not just the new ones. It is harmless, because the
bug was **query-side** amplification: the query goes through the same function, so
nobody typing "Gold Edition" produces those trigrams any more, and this row is now
only reachable by searching that exact German title, which would be a correct match.
If it ever matters, move the strip after the `[^a-z0-9 ]` pass rather than widening
the pattern.

---

## 3. Steam — the only clean one

**Auth.** Steam is an OpenID 2.0 provider at `https://steamcommunity.com/openid/`.
The user signs in on Steam's own page and is redirected back with OpenID parameters;
we verify them server-side and get a SteamID64. We never see a Steam password. Valve
requires one of their supplied "Sign in through Steam" button images.

Supabase Auth has no Steam provider and OpenID 2.0 is not OIDC, so this cannot be a
Supabase social provider. It is two small edge functions: one that builds the
redirect, one that receives the callback and performs the OpenID `check_authentication`
round trip. **The verification must happen on the server** — the `claimed_id` in the
redirect is attacker-controlled until Steam confirms it, so a client that just posts
us a SteamID is an account-takeover-by-impersonation bug.

**Data.** `IPlayerService/GetOwnedGames` with `include_appinfo=1`,
`include_played_free_games=1` and `skip_unvetted_apps=0` returns every appid plus
`playtime_forever` in **minutes**. `GetPlayerAchievements` gives per-game completion.

> **Corrected 14 Sep 2026, second time — from the first outside tester.** This
> paragraph said "every appid". It does not return every appid, and two separate
> things were missing.
>
> 1. **`skip_unvetted_apps` defaults to true** and silently drops apps Valve has
>    not fully vetted. Adding `skip_unvetted_apps=0` took the tester's account from
>    5 games to 7; both recovered games were already in our catalog, so both were
>    pure loss. On the 4,652-game reference library it adds 15 (+0.3%). Now set.
> 2. **A free-to-play game the user has never launched is not returned at all**,
>    and we cannot get it. Steam grants the F2P license on first run; before that
>    the account does not own it, so no parameter exposes it. The gate is
>    **ownership, not playtime** — purchased games with zero hours come back fine
>    (4,504 of the reference library's 4,652 rows are `playtime_forever: 0`). The
>    community profile XML (`/games?tab=all&xml=1`) that used to list them now 302s
>    to a login page.
>
> Measured on tester account `76561199670893904`: 11 games visible in his own Steam
> library, 5 returned before the fix, 7 after, 6 of those 7 in our catalog (the
> seventh is a demo). **The residual 4 are structurally unreachable.**
>
> **This lands on the app, not the backend.** `ImportResult.total` is the length of
> this list, so "we added 4 of your 5 Steam games" is shown to a user looking at 11.
> The count is not a safe thing to present as "your Steam library" — see section 3a.

> **Corrected 14 Sep 2026.** This paragraph previously also claimed the response
> carries per-device splits (`playtime_windows_forever`, `playtime_mac_forever`,
> `playtime_linux_forever`, `playtime_deck_forever`) and `rtime_last_played`. It
> does not. Measured against a real public 4,652-game library
> (SteamID `76561198023414915`), every row carried exactly:
>
> ```
> appid, name, playtime_forever, img_icon_url, content_descriptorids,
> has_community_visible_stats, has_leaderboards
> ```
>
> and with `include_extended_appinfo=1`, additionally `capsule_filename`,
> `sort_as`, `has_dlc`, `has_market`, `has_workshop`. **Not one row of 4,652
> carried any of the five fields claimed above.** They are documented fields, but a
> third-party publisher key reading *another* user's profile does not receive them.
> Consequence: **there is no last-played date and no per-device split**, so anything
> downstream that wants "last played on Deck" has to get it elsewhere. The original
> claim came from Valve's docs rather than from a call.

**The overflow is closer than section 8a makes it sound.** That same real library
has **9,120.6 hours** on Counter-Strike 2 — 880 hours from breaking an unclamped
import, on an account that exists today.

**The one friction point** is real and will be our top support complaint: the user's
**Game details** privacy must be Public, or the call returns an empty list. Handle
it with a specific error and a deep link to `steamcommunity.com/my/edit/settings`,
not a generic "import failed".

Measured 14 Sep, because the exact shape decides whether we can even detect it: a
private profile is **HTTP 200 with the body `{"response":{}}`** — no `games` array
and, critically, no `game_count` key either. It is indistinguishable from a
successful import of zero games unless you test for the missing `game_count`. (A
bad API key is a 403, so the two failures are at least distinguishable from each
other.) `fetchOwnedGames` throws `SteamProfilePrivateError` on that shape rather
than returning `[]`, because returning an empty list would report success.

**Terms** (Steam Web API Terms of Use, checked 12 Sep): 100,000 calls/day — a
non-issue, one call imports a whole library. We must publish a privacy policy naming
what Steam data we store and the country it is stored in, retrieve Steam data only
when the end user asks, and delete all copies if we stop using the API. Nothing there
blocks us. The API key is ours and lives server-side only.

**Verdict: build it.** Legitimate, one join, one call per user, and it populates a
demo library with hundreds of games in seconds. **BUILT AND VERIFIED 14 Sep 2026** —
a real 4,652-game library imported through the deployed endpoint in 3.4 seconds.

> One defect found during that verification, recorded because its *shape* recurs in
> this codebase: `shelf_resolve_external_ids` originally returned `setof`, and
> PostgREST silently truncated it at its default `max-rows` of 1,000. The import
> answered 200, wrote 956 real games, and reported 1,000 of 4,652 matched — with
> Counter-Strike 2 among the "unmatched". Nothing errored. It is the same failure as
> `SEED_MIN_POPULARITY` being read by no code: the system reports success while doing
> a fraction of the work, and only a number you already knew the answer to reveals
> it. Fixed by returning a single `jsonb` value, which makes the cap structurally
> unreachable. **The lesson is the measurement, not the fix** — this was invisible to
> every check except comparing the live import against an independently measured
> number.

---

### 3a. What the app must not say — "N of your M Steam games"

The import response carries `total` (what Steam handed us) and `matched` (what
reached the catalog). The endpoint comment recommends showing both, and that is
still right — but **`total` is not "your Steam library"** and must not be labelled
as if it were. Two different things are missing from it:

| Sola's account | count | reachable? |
|---|---|---|
| Games he sees in Steam | 11 | — |
| Returned by the API *before* the fix | 5 | fixed, now 7 |
| Returned *after* `skip_unvetted_apps=0` | 7 | yes |
| In our catalog | 6 | yes — 1 is a demo |
| Free-to-play, never launched | 4 | **no, ever** |

So the honest sentence is about what we added, not about what fraction of his
library it is: **"Added 6 games from Steam"**, with the unmatched count available
on a details tap. "We added 4 of your 5 Steam games" is worse than saying nothing —
it asserts a library size the user can see is wrong, which makes the 4 look like a
bigger failure than it is *and* discredits the number that is actually correct.

**Confirmed on the tester's four missing games, 14 Sep 2026.** He named *Life is
Strange* as one he had "launched years ago". Both free Life is Strange appids
(`319630` Episode 1, `532210` Life is Strange 2) are F2P, so it fits the rule — but
the real explanation is simpler and more important: **his Steam account was created
2024-04-11.** Life is Strange shipped in 2015. He played it, but not on this
account, and Steam shows him no playtime either. There is nothing to recover.

### 3b. The constraint nobody costed: a player's history is older than their Steam account

This generalises past Steam and past imports. The games people most want on a shelf
are the ones they played *years* ago, and those are the least likely to be in any
account we can read — wrong platform, wrong account, before the account existed, or
a console that has no API at all (section 6). Import is very good at the recent
tail and structurally blind to the part with the most sentiment attached.

Two consequences for build order:

1. **Import is an accelerant, not the shelf.** Search and manual add are not the
   fallback path for when import fails; they are how the shelf gets the games that
   matter. Anything that treats "connected Steam" as onboarding-complete will leave
   users with a shelf that misrepresents them.
2. **The post-import screen should invite the gap, not hide it.** After "Added 6
   games from Steam", the next thing on screen should be a search box with a prompt
   along the lines of *"What else have you played?"* — at the one moment the user is
   already thinking about their own history. That is a better use of the screen than
   a completion percentage, and it is where the paywall ordering (section 4 of
   pricing.md) already puts the user's attention.

If we want to explain the gap in the UI, the true statement is: *"Steam only shares
free-to-play games you've actually launched."* That is Valve's behaviour, it is not
something we can work around, and it is better said once in the import screen than
discovered by every tester.

## 4. Xbox — buildable, but it is a matching job

There is no public official Xbox Live API; Microsoft gates it behind a partner
agreement. Everyone routes through **OpenXBL** (`xbl.io`).

**Auth is better than it looks.** Beyond the personal key (which only reads your own
account), OpenXBL has a real delegated flow: send the user to
`https://xbl.io/app/auth/{YourPublicKey}`, they sign in at Microsoft, we get a `code`
on our redirect URL, and we claim it within a few minutes for *their* key. Requests
made with a consumer key must carry the static header `X-Contract: 100`. So the
credential is the user's, not ours — the right shape.

**Endpoints:** `GET /api/v2/player/titleHistory` for played titles,
`GET /api/v2/achievements/player/{xuid}` for achievements,
`GET /api/v2/account` for the profile. Auth header is `x-authorization`.

**Rate limit is the real constraint.** The free tier is **150 requests/hour**; paid
starts at $5/month for 500/hour, and 429 on overage. Title history is one request,
so a plain library import is cheap — but per-title achievements are not. Import
titles synchronously, queue achievements in the background, and never block a screen
on it.

**DECIDED 14 Sep: we stay on the free 150/hour tier.** That makes Xbox
**import-only**. The 150/hour ceiling is app-wide, not per-user — one shared key —
so a single 200-game library would spend 200 calls and blow the whole app's hourly
budget on one person. Do not build achievement sync against this tier; it is not a
matter of queueing it more politely. Revisit only if we buy the $5/month 500/hour
tier, and even then treat 500/hour as an app-wide budget to be divided.

**The catch, and it is now measured rather than asserted: the title IDs do not join
*in IGDB*, but they can be bridged.** See 4a.

### 4a. The DisplayCatalog bridge — measured 14 Sep, re-measured 15 Sep 2026

Josh challenged the "no lookup table at any price" line on 14 Sep and set the test
himself: *"run the batch job first and measure it... If it's above 70% you're in
good shape; below 50% and you're back to name matching as the primary path rather
than the fallback."* The job is `scripts/link-lab/xbox-title-bridge.ts`
(`npm run lab:xbox-bridge`). Here is the number.

**The bridge itself works, and Josh was right that it exists.**
`displaycatalog.mp.microsoft.com/v7.0/products?bigIds=…` returns an `AlternateIds`
array, and `XboxTitleId` is in it:

| | |
|---|---|
| IGDB `microsoft` external rows | 15,545 |
| …that are 360-era GUIDs, not bigIds | 1,132 (excluded — DisplayCatalog cannot look these up) |
| …that are Store product ids | 14,413 |
| …for games in **our** catalog | 5,154 |
| **of those, returned an `XboxTitleId`** | **4,765 = 92.5%** |

**The limiter is exactly where Josh predicted it would be — IGDB's Microsoft
coverage, not the bridge.** Our catalog holds 7,831 games on an Xbox platform
(49, 169, 12):

| denominator | carry any Microsoft id | reachable by title id |
|---|---|---|
| all 7,831 Xbox catalog games | 4,464 = 57.0% | **4,353 = 55.6%** |
| the 4,884 with ≥ 5 ratings | 3,157 = 64.6% | **3,070 = 62.9%** |

The rated subset is the fairer proxy — an import only ever sees games somebody
actually played, and played libraries are popularity-weighted — so **62.9% is the
number to quote and 55.6% is the floor.**

> **RE-RUN 15 Sep confirms the ratio, as predicted.** The 14 Sep numbers were
> measured with the `.range()` paging bug (§10) and covered an arbitrary ~two
> thirds of the catalog; the catalog has also grown to 91,806 rows since. Re-running
> after both the paging fix and the growth moved every denominator (7,223 → 7,831
> Xbox games, 4,301 → 4,884 rated) but the ratio barely moved: **63.3% → 62.9%**
> rated, **55.5% → 55.6%** floor. Treat 62.9%/55.6% as the confirmed numbers; the
> verdict below did not need to change.

**Verdict: between Josh's two thresholds, so neither of his conclusions fires.**
62.9% is below the 70% that would justify building id-first and above the 50% that
would send us back to name matching alone. The decision that follows is not either
of the two he named:

> **Build the bridge as a precision layer over the name matcher, not as a
> replacement for it.** Where a title id resolves, trust it absolutely — it is
> deterministic and cannot mis-match. Where it does not, fall back to
> `shelf_match_title()`, which measured **97.0% rank-1 / 99.5% top-5** on real
> store names (section 2a). The id route covers about two thirds of the cases with
> certainty; the matcher covers everything, slightly less certainly. Running both
> costs one extra SQL lookup.

**And it does not re-rank the build order.** The argument for moving Xbox ahead of
Android was that a deterministic join would make Xbox as cheap as Steam. At 62.9%
it does not: the name matcher still has to be wired up, which was the whole cost of
the Xbox build. Xbox stays at step 4. What has changed is that when it is built, a
measured two thirds of it will be exact rather than fuzzy.

Two of Josh's three caveats are confirmed and handled; the third is measured:

- **Unofficial, may change.** Handled by making it a build-time artifact. The map
  is written into `game_external_ids` as `source = 'xbox_title'` by the `--write`
  flag; nothing at request time calls DisplayCatalog.
- **Many-to-many.** Confirmed, and `game_external_ids` has no unique constraint on
  `(source, uid)` for exactly this reason — it stores edges and the importer
  resolves.
- **PC-only Store products carry no `XboxTitleId`.** Confirmed: that is most of the
  7.5% the bridge misses, and it is correct behaviour, since those titles never
  appear in Xbox Live title history either.

---

## 5. PlayStation — three separate problems, only one of which encryption fixes

**Problem 1: the NPSSO is password-equivalent.** psn-api exchanges an NPSSO cookie
for an access code, then for access + refresh tokens. The NPSSO is a session cookie
granting full account access — store, wallet, everything — not a scoped read-only
game token.

Josh's instinct to encrypt it properly is right but aimed at the wrong risk. The
exposure is not primarily storage, it is *holding thousands of Sony session
credentials in a hackathon codebase*. **The fix is to never store it**: accept the
NPSSO, exchange it for tokens inside the same request, persist only the refresh
token, and discard the NPSSO before the function returns. The refresh token is
scoped and expires. That costs nothing and is a genuine reduction in blast radius.

Concretely, the NPSSO must never be written to a table, a log line, or an error
message — which in our stack means it also must not travel as a query parameter,
because Supabase logs those.

**Problem 2: `getUserTitles` returns games you have earned trophies in, not games
you own.** Anything installed but never played, or played without popping a trophy,
is simply absent. The import will be incomplete and users will notice; say so in the
UI rather than letting them think we lost their games.

**Problem 3: the UX is genuinely bad on mobile.** The user must leave the app, sign
in to Sony in a browser, open `ca.account.sony.com/api/v1/ssocookie`, copy a
64-character string out of raw JSON without the quotes, come back, and paste — then
repeat when the refresh token dies. Desktop tools use a bookmarklet; we have no such
option. Put it behind an "advanced" disclosure, detect the token in the clipboard on
return, and validate immediately so a bad paste fails in one second.

**And the IDs still do not join**, so PSN also resolves by name.

**Verdict: last, and only if the core loop and paywall are done.** Highest effort,
highest risk, worst UX, and an incomplete result even when it works.

---

## 6. Nintendo — no

The usual reason given is that the API is private. The disqualifying reason is
sharper: generating the `f` token the Nintendo Switch Online app's API demands
requires sending a Nintendo-issued `id_token` to a **third-party signing service**
(imink or flapg). That means routing our users' Nintendo session material through
somebody else's server. That is a line worth holding regardless of what the ToS say.

And it would not even pay off: the NSO app API exposes presence and friends, **not an
owned-games list**. There is no library to import. Every tracker in this category
falls back to manual entry for Nintendo.

**Say "manual for now" in the UI and move on.** Nobody in the category has solved
this, so we are not behind.

---

## 7. The one nobody expects: Android package names *do* join

IGDB source 15 stores the **Play Store package name** verbatim
(`com.picsoft.tinydefense`). That is exactly the string the `<queries>` manifest
trick from Josh's thread returns.

So the "we found 14 games on your phone" onboarding moment is a **direct join**, same
shape as Steam, no matching heuristics. The catch is coverage: only 368 of our 2,171
rated Android games carry a package name (17.0%), and 3,036 rows exist in all of
IGDB. A curated top-500 list shipped in the manifest is therefore not a shortcut, it
is a **requirement** — and it also means the app-side list and our catalog have to be
built from the same IGDB query, or they will disagree.

iOS has no equivalent. Apple's App Store IDs are in IGDB (source 13, 31.5% coverage),
but there is no API on the device that will tell us what is installed.

---

## 8. What has to change in this backend

Four defects, found by reading the live schema against what an import actually
writes. Two of them fail the way the "Where Winds Meet" bug failed.

**8a. `library_entries.hours_played` is `numeric(5,1)` — max 9,999.9.**
Steam returns `playtime_forever` in minutes and long-time CS/Dota players are well
past 10,000 hours. One such row raises `numeric field value out of range` and takes
the entire batch page with it — the exact failure that killed the first catalog seed.
**Clamp on the way in**, the way `mapping.ts` already clamps `ttb_*_hours`. Do not
widen the column: a clamped 9,999.9 is honest enough, a failed import is not.

**8b. `unique (user_id, game_id)` collides during import, and the parent hop makes it
worse.** Two Steam apps routinely resolve to one catalog game once editions collapse
onto their parent (Skyrim + Skyrim Special Edition). A naive `insert` of 400 rows
fails on the first collision. The importer must dedupe *before* writing and use
`on conflict (user_id, game_id) do update` — and it must never overwrite a status the
user set by hand. An import should fill in blanks, not relitigate the shelf.

**8c. `source_kind` has no import value.** The check constraint allows
`('tiktok','youtube','search','manual')`. Imported rows need their own provenance —
`'steam' | 'xbox' | 'psn'` — or we cannot tell an imported row from a typed one, and
cannot undo an import cleanly when a user disconnects.

**8d. Nothing stores the external ID mapping.** `games` has `igdb_id` and `rawg_id`
and nothing else. Doing the appid → IGDB lookup live at import time means IGDB round
trips under a 4 req/sec throttle on the user's critical path.

**Build a `game_external_ids` table instead** — `(game_id, source, uid)` — seeded
from `external_games` for the sources we care about, restricted to our catalog. That
is on the order of 100k rows and single-digit MB against 108 MB used of the 500 MB
free-tier cap. A 400-game Steam import then becomes **one SQL statement with zero
network calls**, and the seed script gets a third pass alongside platforms and games.

**8e. This changes an answer already sitting with Josh.** The semantic-search
research (11 Sep, `docs/research/semantic-search.md`) asked him to widen the seed's
`game_type` filter — 2,042 games gained, **510 duplicate titles created** — and I
recommended doing it. The parent hop is a better answer to the same problem: it
reaches the editions and remasters an import needs *without* putting 510 duplicate
titles into search results. **Recommendation withdrawn.** Resolve editions at import
time through `parent_game`; leave the seed filter alone. If he has already said yes,
that is worth un-asking before anyone acts on it.

One more, not a defect but a decision: **a 400-game import versus
`FREE_TIER_GAME_LIMIT` (50).** The app counts library rows against that limit. An
import is the single best argument for Pro and the single fastest way to make the
free tier feel broken. Decide deliberately — my recommendation is that imported rows
count, but the paywall appears *after* the import shows what it found, not before.
Seeing 412 games and then being asked to pay is a far better moment than being asked
to pay for a number you cannot see yet. This is Josh's call, not mine.

**DECIDED 14 Sep: taken as written.** Imported rows count against the 50 limit, and
the paywall appears after the import result. Sola owns the ordering in the app; the
backend change is nothing beyond leaving `FREE_TIER_GAME_LIMIT` where it is.

### 8d. Re-import after a disconnect freezes playtime — FIXED 15 Sep 2026

Found 14 Sep 2026, immediately after the tester's import. Not a hypothetical:
`verify:linking` §5a exercises it and the three assertions there **pass**, because
they pin what the code does rather than what it should do.

**The mechanism.** `shelf_disconnect_platform` sets `source_kind='manual'` and
`imported_uid=null` on every row the user had edited (that part is right — the shelf
is theirs). But `shelf_import_library` then says:

```sql
source_kind  = coalesce(library_entries.source_kind, excluded.source_kind)
hours_played = case when library_entries.source_kind = p_source then excluded.hours_played
                    else coalesce(library_entries.hours_played, excluded.hours_played) end
```

`'manual'` is not null, so `coalesce` keeps it, so the row never rejoins `'steam'`,
so the hours branch never fires again. **Measured: a row at 6.0 hours stays at 6.0
after a re-import carrying 25.0.** Silently, permanently, on exactly the games the
user cared enough to rate.

It also leaves the row's provenance contradicting itself: `imported_uid` *does* come
back (disconnect nulled it, so `coalesce` takes the new value) while `source_kind`
does not. A later disconnect filters on `source_kind`, so it will never clear that
uid — a `'manual'` row carrying a Steam appid, for good.

**Why it will actually happen.** Only a disconnect can put a row in this state, so
it looks rare — until you notice there may be no other way to re-sync. When the
tester's import looked wrong, "disconnect and reconnect" is what he reached for. If
the app has no **Sync now** on the Steam connection screen, that is not an edge case,
it is the main path.

**Two fixes, and they are not equivalent:**

1. **App-side, and needed regardless: add a "Sync now" action.** `POST /steam-import`
   is idempotent and safe to call repeatedly — it refreshes hours on rows the import
   owns, inserts anything new, and leaves edits alone. This removes the *reason*
   anyone disconnects, and costs nothing. **Do this one either way.**
2. **Backend: let a re-import re-adopt a `'manual'` row.** Fixes the freeze at the
   source, but changes shipped semantics, which is why it is written up rather than
   applied. The argument for: provenance and playtime are *ours*; status, rating and
   notes are *theirs*. A game sitting in the user's Steam library really did come
   from Steam, and its hours really are what Steam says. The argument against: a
   game the user hand-added **with their own hours** would have those hours
   overwritten the first time they connect Steam — and `verify:linking` §4 currently
   asserts the opposite ("a hand-added row keeps its own hours"). That check would
   have to be rewritten, which is precisely the kind of thing worth noticing before
   doing rather than after.

My recommendation: **do 1 now, and 2 only if we also keep a user's hand-entered
hours.** That likely means distinguishing "hours the user typed" from "hours nobody
has ever set", which the schema cannot currently express — so 2 is a schema question
wearing a function-body costume, and it should not be rushed to unblock something
that fix 1 already unblocks.

**FIXED 15 Sep 2026 — option 2, built as `hours_played_is_own`.**
`20260915150000_reimport_reclaims_hours.sql` adds a boolean column to
`library_entries`: `false` means the last write to `hours_played` came from an
import and `shelf_import_library` may reclaim it on the next one; `true` means a
human set it — directly, or by hand-adding the row — and no import may touch it
again. `shelf_import_library` now gates `hours_played`, `source_kind` and
`imported_uid` together on `not hours_played_is_own`, replacing the old
`source_kind = p_source` check that could never come true again once a disconnect
set `source_kind='manual'`.

The column alone was not enough, because `library_entries` carries an "own rows,
all operations" RLS policy (`20260905000300_rls.sql`) — the app can `PATCH`
`hours_played` directly, no RPC required, and a direct edit had to look different
from an import's stale figure or the ambiguity option 2 was blocked on would just
move house. A `before insert or update` trigger,
`library_entries_hours_ownership`, closes that: it flips the flag to `true`
whenever anything changes `hours_played` *except* `shelf_import_library` itself,
which marks itself with a transaction-local `set_config('shelf.importing', 'on',
true)` the trigger checks for. `shelf_import_library` is the only writer allowed
to flip the flag back to `false`, and only on a fresh insert.

Fix 1 (a "Sync now" button) is still worth building — it is the better UX, since it
never requires a disconnect at all — but it is no longer covering for a bug. The
freeze is fixed regardless of whether Sola builds it. `verify:linking` §5a is
rewritten (not deleted, per the rule at the top of this section) to assert the fix,
and a new §5b pins the direct-PATCH case the trigger exists for.

---

---

## 9. Store policy — the two rules that keep this clean

**Apple 4.8 does not apply, and this is why it must stay that way.** The guideline,
verbatim, binds apps that use a third-party login "to set up or authenticate the
user's **primary account**". Steam, PSN and Xbox must therefore be *connections
inside an already-signed-in Shelf account*, never sign-in methods. The moment
"Sign in with Steam" becomes an authentication path, Sign in with Apple is pulled
into scope. Keeping them as connections costs nothing and avoids the whole question.

**Two rules from the thread, both worth keeping verbatim:**

1. Never ask for a platform password directly — only tokens and OAuth.
2. Ship a plain-English screen saying exactly what we pull and what we store, with a
   disconnect button that actually deletes. Two hours of work, and it is what keeps
   us on the right side of both store reviews. Apple 5.1.1 already requires in-app
   account deletion; per-connection deletion is the same idea one level down.

Note also that none of this is illegal — it is contract. The risk is a revoked key or
a platform complaint, not prosecution. Minimap and Backloggr both ship PSN and Xbox
sync today, so it demonstrably survives store review.

---

## 10. Build order

**Prerequisite (half a day, do it first, it is the thing everything else needs):**
`game_external_ids` + a seed pass. Without it every import is a pile of throttled
IGDB calls on the user's critical path. **BUILT 14 Sep** —
`20260914100000_game_external_ids.sql` and `scripts/seed-external-ids.ts`
(`npm run seed:external-ids`), which also seeds `microsoft` and `android` because
they come out of the same IGDB pull.

   **RE-SEEDED 15 Sep, and the first two runs were wrong in a way nothing reported.**
   `catalogByIgdbId()` paged the catalog with `.range(from, from + 999)` and no
   `.order()`. Postgres promises no row order without an ORDER BY, so the OFFSET
   windows skipped rows and repeated others: the seed read **~60,000 of 91,806**
   games, a *different* ~60,000 each run (measured: 59,879, then 59,212, then 91,806
   once keyset paged). It never errored and its summary looked healthy, so roughly a
   third of the catalog silently had no store ids written and every import quietly
   fell back to name matching for those games. Fixed to keyset paging on `igdb_id`,
   the same thing `pullSource()` already did against IGDB, and pinned by
   `npm run verify:external-id-paging`, which asserts the read returns every eligible
   row and returns the same set twice running.

   **`scripts/link-lab/xbox-title-bridge.ts` had the identical loop**, so the **63.3%
   bridge figure in §4a was measured over about two thirds of the eligible catalog**.
   **RE-MEASURED 15 Sep** with the loop fixed: **62.9%**, confirming the ratio held.
   See §4a.

1. **Steam** — OpenID edge function, `GetOwnedGames`, direct join, parent hop.
   **BUILT 14 Sep** — four functions (`steam-link-start`, `steam-link-callback`,
   `steam-link-finish`, `steam-import`), verified by `npm run verify:linking`.
2. **Schema fixes 8a–8c**, which are one small migration and are needed by *every*
   import, not just Steam. **BUILT 14 Sep** — 8a is a clamp in
   `_shared/platform-import.ts` rather than a migration (the column is deliberately
   not widened); 8b is `shelf_import_library()` in
   `20260914100200_import_library.sql`; 8c is the widened `source_kind` constraint
   plus `imported_uid` in `20260914100100_platform_accounts.sql`.
3. **Android package detection** — direct join, and it is a genuine Android-exclusive
   feature and a Galaxy Store argument.
4. **Xbox** — OpenXBL delegated auth, title history, **the DisplayCatalog title-id
   bridge for the 62.9% it reaches (section 4a), name matching for the rest.** A
   day. Import-only: we are on the free 150 req/hour tier and that ceiling is
   app-wide.
5. **PlayStation** — tokens-not-NPSSO, name matching, behind an advanced disclosure.
   Only if 1–4 are done.

**Not building:** Nintendo (section 6), Epic (no third-party API), GOG (audience does
not justify the day, though the IDs join cleanly if that changes).

**Worth flagging as the cheapest win in the whole area, and it is not a platform at
all:** a CSV importer for Backloggd / GG / Grouvee / Minimap. Zero credentials, zero
ToS exposure, zero platform risk, an afternoon of work, and it targets users who are
already annoyed at an app that has not shipped a feature since 2023.

---

## 11. What I need from Josh

0. ~~**Run one migration.**~~ **DONE 12 Sep** — `20260912120000_standard_edition_suffix.sql`
   is applied and verified; Xbox name matching went 96.3% → 97.0% rank 1.
1. ~~**A decision on 8d's free-tier interaction.**~~ **DECIDED 14 Sep** — the paywall
   lands **after** the import result, and imported rows **count** against the 50-game
   limit. That is the section 8 recommendation taken whole: run the import, show the
   user every game it found, then ask. See `docs/research/pricing.md` §4 for the
   evidence that this is also the higher-converting placement.
2. ~~**A Steam Web API key.**~~ **RECEIVED 14 Sep**, in `docs/decisions-for-josh.md`
   along with the OpenXBL key. **Both are in plaintext in a tracked file and must be
   moved to Supabase secrets before that file is committed.** Server-side only,
   never ships in the app.
3. ~~**An OpenXBL account and app registration** (`xbl.io`) for the public key, and a
   decision on the $5/month tier.~~ **DONE 14 Sep** — key received, and we are
   **staying on the free 150/hour tier**. Consequence, stated plainly so nobody
   builds against it: **Xbox is import-only, achievement sync is out of scope.** See
   section 7 for why the ceiling is app-wide rather than per-user.
4. ~~**Confirmation that the privacy policy exists and names Steam.**~~
   **CONFIRMED 14 Sep** — the policy names Steam, which satisfies the Steam Web API
   terms. Nothing further blocks the Steam import on policy grounds.
5. **Nothing for PlayStation yet.** Do not create anything until 1–4 are shipped.
6. ~~**Measure the DisplayCatalog bridge before re-ranking Xbox.**~~ **DONE 14 Sep,
   RE-MEASURED 15 Sep after the paging fix** — the job is `npm run lab:xbox-bridge`
   and section 4a has the numbers. Short version: the bridge works (92.5%), IGDB's
   Microsoft coverage caps it at 62.9% of a played library (was 63.3% on the buggy
   denominator — the ratio held), that lands between your two thresholds, so it
   becomes a precision layer over the name matcher rather than a replacement, and
   **Xbox does not move ahead of Android.**

**What is now owed to you rather than by you:** the Steam and OpenXBL keys must be
set as **Supabase secrets** before any of the new functions can read them. They are
in `.env` and gitignored; no edge function can see a `.env`. The command is in
`docs/STATUS.md`.

Migrations and deploys still need you — I cannot push. When the schema change is
ready it will come as a `!` command, migration first, deploy second.

---

## Appendix — how to re-run the measurements

The scripts live in `scripts/link-lab/` and read `.env` for `TWITCH_CLIENT_ID`,
`TWITCH_CLIENT_SECRET`, `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

| script | what it measures |
|---|---|
| `external-id-coverage.ts` | §1 table 3 — external ID coverage of our catalog, per source |
| `steam-resolution.ts` | §1 table 1 — end-to-end Steam library resolution, and the parent hop |
| `gap-diagnosis.ts` | §1 table 2 — why the missing 398 are missing |
| `name-match.ts` | §5 — store name → `shelf_search_games` hit rate for PSN and Xbox |
| `xbox-title-bridge.ts` | §4a — DisplayCatalog Store-id → XboxTitleId, and the resulting ceiling. `--write` persists the map. Caches its answers in `.xbox-title-cache.json`; delete that to re-pull |
| `real-steam-library.ts` | §1 against a **real** library instead of the SteamSpy proxy. Takes a SteamID64 or a vanity name and needs neither a linked account nor the OpenID handshake |

SteamSpy is the only unauthenticated dependency of the original four; if it goes
away, substitute any list of appids sorted by ownership. The measurement is only as
good as that proxy — a real user's library skews cheaper and more obscure than the
top 2,000, so treat 87.8% as an **optimistic bound**. `real-steam-library.ts` is how
you stop guessing: point it at any public profile and it reports the same figures
through the shipping RPC.
