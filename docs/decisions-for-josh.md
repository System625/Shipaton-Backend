# Shelf: Games DB decisions I need from you

**For:** Josh
**From:** Tunde
**Date:** 4 September 2026
**Deadline we are working to:** 30 September 2026, 11:45pm PDT

I did a research pass before writing any code, then re-checked every external claim against the vendors' own documentation on 4 September. Below is what I found and the seven things I need you to approve or reject. Everything else I can decide myself.

---

## First, the thing that worries me most

The Shipaton rules say the app's first public version must launch between 1 August and 30 September, and it has to be actually released on the App Store, Google Play, or Samsung Galaxy Store. Built and working is not enough.

Since you shipped for the last RevenueCat hackathon, I am assuming the store accounts and RevenueCat project already exist. One thing I still need you to check, because it bites per app rather than per account:

If the Play Console account is a **personal** account created after 13 November 2023, every **new** app needs its own closed test with 12 testers opted in continuously for 14 days before you can apply for production access. Having shipped a previous app does not carry over. Organisation accounts registered to a legal business entity are exempt.

**Correction, and it is worse than I first told you.** I said 12 September. That number only counted the 14 testing days and left out the two review stages after it. Working backwards from 30 September:

| Step | Duration | Latest start |
|---|---|---|
| 12 testers opted in continuously | 14 days | **6 September** |
| Request production access, Google reviews | "7 days or less" | 20 September |
| Publish, app review | 2 to 3 days | 27 September |

So the real cutoff is about **6 September, which is Saturday**, with no slack anywhere in the chain. At 12 September the path does not close at all if Google takes its full review week.

One thing I overstated: Google does not formally require that all 12 testers actively use the app. It asks you to describe whether "testers used all available app features" in the production access questionnaire. Real, but softer than a hard check.

For contrast, iOS review runs 2 to 5 days for a new app, so that path stays comfortable.

**Please confirm today:** is the Play account personal or organisation? If it is an organisation, or a personal account created before 13 November 2023, none of this applies and we are fine. If not, we almost certainly ship iOS and treat Android as a stretch, and I would rather we decide that now than discover it on the 25th.

---

## Decision 1: IGDB as the game data source

**Correction. You approved RAWG on my recommendation and I got that wrong. Please re-approve.**

I told you IGDB's commercial terms were unresolved. I was working off a forum post from 2020. When that got challenged I went and read IGDB's current documentation, and it says the opposite. Quoting their FAQ directly:

> **I want to use the API for a commercial project, is it allowed?**
> Yes, we offer commercial partnerships for users looking to integrate the API in monetized products.

> **What is the price of the API?**
> The API is free for both non-commercial and commercial projects.

> **Am I allowed to store/cache the data locally?**
> Yes. In fact, we prefer if you store and serve the data to your end users.

So the reason I picked RAWG has evaporated, and on the merits IGDB is better for us:

| | IGDB | RAWG |
|---|---|---|
| Cost | Free, including commercial | $149/month for commercial |
| Monthly request cap | None, 4 requests/second instead | 20,000 free, 50,000 paid |
| Storing data on our servers | Encouraged, formally once we are partners | Prohibited |
| Bulk data dumps | Every 24 hours, partners only | None |
| If we stop using them | We keep all the data | n/a |
| Time to finish a game | Three estimates plus a confidence count | One averaged number |
| Cover art | Real box art | A screenshot |
| PC system requirements | None | Yes |

The 20,000 requests a month I flagged as a worry in my last message is a RAWG limit. It disappears entirely.

Two corrections to my own table, since I want you deciding on accurate numbers. The daily data dumps are **partners only**, so we do not get them on day one, and I have changed the plan to seed straight from the API instead, which takes about a minute either way. And RAWG has PC system requirements that IGDB simply does not publish, so we lose that one field. Nothing in the cut scope uses it.

**One thing you need to do, today.** Commercial use runs through a partnership, which means emailing **partner@igdb.com**. It is free. There is no published turnaround anywhere, so assume they may not reply before the deadline.

I want to be straight about why this matters more than I first said. IGDB's FAQ says caching is fine. But their Getting Started page says the API is free for **non-commercial** use under the Twitch Developer Agreement, and that agreement says not to store their data for more than 24 hours without written authorization. Our whole design is a stored catalog, and Shelf has a paywall, so we are a commercial product from day one. The partnership is what makes the architecture legitimate, not just polite.

In practice: their FAQ and that agreement genuinely disagree, so this is ambiguity rather than a clear breach, and the risk of anything happening inside a 30 day contest is low. The exposure is later, if Shelf wins something and keeps running on data we have no documented right to store. That is why the email should be dated before we ship.

We are not blocked while we wait. The API is free and available immediately with a Twitch account, and it gives us every field we need, so building starts today either way. Both providers require visible attribution, so that part of the design does not change.

**There is also nowhere better to go.** I researched the alternatives properly. Giant Bomb's API is offline entirely since they split from Fandom, with no timeline to restore it. MobyGames ended free access and now starts around $100 a month for a slower tier. RAWG is the only real fallback and costs $149 a month for commercial use, with one averaged playtime number instead of three and screenshots instead of box art. So the choice is not IGDB versus something similar. It is IGDB or pay more for less.

**Approve or reject.**

---

## Decision 2: I start the backend

**My recommendation: yes, and it is unavoidable.**

We cannot put API credentials inside the app. Anyone can pull them out of the bundle. IGDB is explicit about this in their own docs: they do not allow the app to call them directly, and tell you to put a backend in between. So this is settled by the provider, not just by preference.

We also already promise sync as a Plus feature on the paywall, and friends' lists need accounts. All three land on the same server.

I am proposing **Supabase**: Postgres for the game catalog, built in auth, and edge functions to hold the API key. It also has good fuzzy text matching built in, which we need for the share feature below.

**One cost to approve with it.** Supabase's free plan pauses a project after a week of inactivity. Judging runs to 22 October, and a paused backend means judges open Shelf and it does not work. That is a $25/month plan for October, or we commit to keeping it awake ourselves. I would rather just pay it for the judging window.

**Approve or reject.** If Sola would rather own this, say so now rather than in two weeks.

---

## Decision 3: Cut the feature list

**My recommendation: build three things properly.**

We listed eighteen features. We have 26 days, no backend yet, and the app has to be live on a store at the end. That list is a six month roadmap.

Of the eighteen, most are things a dozen existing apps already do. Wishlists, status tracking, and search will not win a category.

The three that are actually ours:

1. See a game on TikTok, hit share, it lands in your backlog with the link attached
2. Tell it "1 hour, PS5" and it picks something from your list
3. Finish a game, rate it, get a card you can post

That is the app. Everything else is supporting cast.

**Approve or reject.** I am asking because the games database looks quite different depending on the answer, and I would rather build the right one once.

---

## Decision 4: The roulette needs data we do not have

Right now every game in the app stores one platform as plain text. Elden Ring is saved as "PS5". In reality it is on six platforms.

"1 hour, PS5" needs two things we do not currently store: which platforms a game is actually on, and roughly how long it takes to finish. IGDB gives us both, so this is fixable, but it means changing the shape of the data Sola already built against.

**Approve or reject:** I redesign the game data model rather than working behind the existing one. This will require some coordination with Sola.

---

## Decision 5: The share feature will ask before adding

I tested this rather than assuming it works.

When someone shares a YouTube link, we get a clean title back. A real example: "ELDEN RING - Official Gameplay Reveal". Easy to match.

When someone shares a TikTok, we get the whole caption. A real example: "Scramble up ur name & I'll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic". Gaming captions look the same way, something like "this boss took me 3 hours 💀 #eldenring".

We can usually pull a game name out of that. We cannot always be right.

**My recommendation:** when someone shares, we guess, then show them what we think it is and let them confirm or correct it with one tap. Silently adding the wrong game to someone's backlog is the fastest way to make them stop trusting the feature, and this feature is the whole pitch.

If we cannot work out the game at all, we still save the link so nothing they shared is lost.

**Approve or reject.**

---

## Decision 6: We lose Expo Go

To receive shares from other apps, we need a library that requires a real build rather than the Expo Go app. It supports our exact Expo version, so this is not a blocker, but it does change how everyone runs the project day to day.

Better to do this in week one than on 25 September.

**Approve or reject.**

---

## Decision 7: The roulette needs two inputs, not one

This one came out of a good question about the "1 hour" idea.

"I have 1 hour" means an hour free tonight. The only data any games database has is how long a game takes to **finish**. Those are different things on completely different scales.

Filter for games beatable in an hour and you get Journey. At four hours you add Portal and Firewatch. You have to reach about ten hours before there is a real pool to pick from.

Worse, everything under four hours is the same kind of game, short narrative indies. So the roulette would deal the same three titles to everybody forever, and would never surface the 55 hour game you have 40 hours left in. Anyone whose backlog is mostly big games gets an empty roll every time.

This is not a threshold to tune, and switching to IGDB does not fix it. It is two different questions sharing the word "hours".

**My recommendation: split them.**

- **"How long have you got?"** does not look at how long the game takes at all. It uses what kind of game it is. Roguelikes, racing, sports, fighting and puzzle games are built out of short runs. Long story RPGs are not. Balatro is the best 45 minute game in Sola's mock catalog and its playtime is effectively infinite, which is the clearest proof that duration was never the right input.

  Worth knowing: this half of the roulette runs on genre and keyword data that every provider has, so it survives even if we ever have to change provider. Only the size question depends on IGDB's better playtime data.
- **"How big a game are you after?"** with Quick, Medium and Epic. This is where time to finish genuinely works.

The cost of saying yes: the roulette becomes two taps instead of one, and your pitch line changes. "Tell it 1 hour and PS5" becomes closer to "tell it how long you have got and what you are in the mood for".

**Approve or reject.** This is the last thing blocking the roulette.

---

## What I do once you answer

1. The games model and share pipeline spec is already written and ready to build from
2. Stand up Supabase and the IGDB sync
3. Hand Sola the contracts so the app screens can be built against them

Two things need you rather than me, today: the Play account question at the top, and the email to partner@igdb.com.
