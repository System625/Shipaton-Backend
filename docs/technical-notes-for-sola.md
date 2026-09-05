# Shelf: Games DB technical notes

**For:** Sola
**From:** Tunde
**Date:** 4 September 2026

I picked up the games database and how new games get added. This is what I found reading your scaffolding, plus what I think has to change. Nothing here is decided. Josh has the approval calls and I have sent him a separate doc with the seven that matter. Treat this as a heads up so nothing lands on you as a surprise.

Updated 4 September after a verification pass against IGDB's own docs. Two things below changed as a result, both marked.

Your structure made this easy to pick up. `searchCatalog` and `findCatalogGame` are exactly the right seam and I am aiming to keep them.

---

## What is changing under you

### 1. Game data comes from a server we own, not from the app

We cannot put API credentials in the bundle, and IGDB does not permit the app to call them directly anyway, so search goes through a small backend of ours. Supabase.

For your side this mostly means `searchCatalog` becomes async and can fail. Loading and error states on Add Game, which do not exist yet.

### 2. `CatalogGame` is changing shape

Three problems with the current type:

**`platform: string` holds one value.** Elden Ring is stored as `'PS5'`. It is on six platforms. Once the roulette can filter by "PS5", we need real platform availability, so this becomes a list.

**`id: 'elden-ring'` is a hand written slug.** It becomes a generated ID, with the IGDB ID kept in a separate field the app never reads. This already earned its keep: I switched provider from RAWG to IGDB mid research and nothing outside the sync layer had to change.

**No time to beat.** "I have 1 hour" has nothing to filter on. IGDB gives three estimates (rushed, normal, completionist) plus a confidence count, so this becomes several new fields.

Rough shape of where it is going:

```ts
export type CatalogGame = {
  id: string;                    // ours, not the provider's
  title: string;
  platforms: Platform[];         // was: platform: string
  releaseDate?: string;
  genres: string[];              // was: genre: string
  coverImageUrl?: string;
  timeToBeatHours?: number;      // new
  sessionFit?: 'high'|'medium'|'low'; // new, drives the roulette
  criticScore?: number;          // new, 0 to 100
  abbreviation: string;          // keeping, good fallback
  colorKey: CoverColorKey;       // keeping
};
```

**Changed 4 September: `pcRequirements` is gone.** I had it in the earlier draft because RAWG has it. IGDB does not publish system requirements at all, so that field could only ever be undefined. Better to drop it than hand you a contract that lies. If we ever need it we would have to get it somewhere else entirely.

On `criticScore`: it is IGDB's aggregate of external critic scores. It is **not** Metacritic, so please do not label it that anywhere in the UI.

I want to keep `abbreviation` and `colorKey`. The coloured swatch fallback is genuinely good and real cover art fails to load more often than you would expect.

### 3. `LibraryEntry` needs to remember where the game came from

The share feature is the whole pitch, and right now there is nowhere to store the link someone shared. Adding roughly:

```ts
sourceUrl?: string;            // the TikTok or YouTube link
sourceKind?: 'tiktok' | 'youtube' | 'search' | 'manual';
```

This is also what makes the finish card interesting later. "Found on TikTok in March, beaten in September" is a better card than a rating on its own.

`hoursPlayed`, `notes`, `rating` and `status` all stay as you have them.

---

## Two things that affect your screens directly

### IGDB attribution is required

We are going with IGDB (I first recommended RAWG and was wrong about their commercial terms, Josh has the correction). IGDB's commercial partnership requires user facing attribution to IGDB.com, visible and in a static place rather than buried in a changelog.

It does not need to be loud. A small line at the bottom of the relevant screens is normal. But it is a requirement rather than a nicety, so worth designing in properly instead of bolting on at the end.

Good news on covers: IGDB serves real box art, close to the Wikipedia art in your mock catalog. RAWG would have given us screenshots instead, so the look you designed for survives.

Size note: IGDB's `t_cover_big` is only 264 x 374, which is soft on a phone. I will serve the `_2x` variant at 528 x 748, so expect roughly that aspect and resolution when you lay out cards.

### We lose Expo Go

Receiving shares from other apps needs `expo-share-intent`, which needs `expo prebuild` and a dev client. Version 8.0 supports Expo SDK 57, which is what we are on, so no version problems. I confirmed this against their compatibility table.

Practically: `expo prebuild` then `expo run:ios` or `expo run:android` instead of Expo Go. Slower first build, then normal.

**One trap worth knowing before you run it.** On SDK 57, `expo prebuild` now clears and regenerates the native `android` and `ios` directories by default. Pass `--no-clean` if you want it to apply changes to the existing folders instead. If you have local native changes in there, they will vanish otherwise.

**A second one, from a cross-check I had run on the plan.** On iOS the share extension and the app are separate processes, and they hand the shared URL over through an App Group. If the App Group identifier is not set up in `app.json` for both, shares fail *silently*: the share sheet shows Shelf, you tap it, and nothing arrives. There is no error to read. I have not hit this myself, so treat it as a thing to check first if iOS shares look like they do nothing, rather than as a confirmed step.

I would rather we all take this hit in week one than discover it on 25 September.

---

## How the share flow actually works

I tested this instead of assuming.

Both TikTok and YouTube give us basic info about a shared link without any authentication. Quality varies a lot.

YouTube returns a clean title:

```
"ELDEN RING - Official Gameplay Reveal"
```

TikTok returns the entire caption:

```
"Scramble up ur name & I'll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic"
```

Real gaming captions look like the second one. Something like "this boss took me 3 hours 💀 #eldenring #soulslike".

So the pipeline is: share arrives, we clean up the text, we search the catalog, and then **the user confirms**. I do not think we can auto add silently. Putting the wrong game in someone's backlog kills trust in the one feature that makes this app different.

One thing I fixed on my side that affects what you see: I am filtering out DLC, expansions, bundles and special editions at ingest. Without that, searching "Elden Ring" returns the base game, Shadow of the Erdtree, the Deluxe bundle and several packs as separate entries, and they would all pile onto your confirm screen. The alternatives list should be genuinely different games, not five versions of one.

What that means for you: a small confirm screen after a share. Best guess shown large, two or three alternatives underneath, and a search box if we got it completely wrong.

There is also an unresolved state. If we cannot work out the game, we keep the link and let the user sort it out later, rather than dropping what they shared.

---

## What is not changing

- Your feature folder structure. It is working and I am matching it.
- Zustand stores stay. Sync gets layered on rather than replacing them.
- `GameStatus` and the shared components stay as they are.
- The RevenueCat service wrapper is untouched by any of this.

---

## Open questions for you

1. Is anything already being built against `CatalogGame`'s current shape that I would break? I would rather change it once, this week, than in three weeks. In particular, is `pcRequirements` used anywhere yet?
2. Do you want to own the confirm screen UI, or should I spec it and hand it over?
3. Are you happy with Supabase, assuming Josh approves it?
4. Your `colorKey` and `abbreviation` fallback is staying. I will derive both server side so it keeps working when cover art fails.

The scaffolding gave me a clear picture in about twenty minutes. Thanks for the README, the "swapping in IGDB or RAWG later" note saved me guessing at the intent.
