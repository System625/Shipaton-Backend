# Shelf: Games DB technical notes

**For:** Sola
**From:** Tunde
**Date:** 4 September 2026

I picked up the games database and how new games get added. This is what I found reading your scaffolding, plus what I think has to change. Nothing here is decided. Josh has the approval calls and I have sent him a separate doc with the seven that matter. Treat this as a heads up so nothing lands on you as a surprise.

Updated 4 September after a verification pass against IGDB's own docs. Two things below changed as a result, both marked.

Your structure made this easy to pick up. `searchCatalog` and `findCatalogGame` are exactly the right seam and I am aiming to keep them.

---

# Update, 7 September: it is live

The backend is deployed and working against real data. Everything below this line was
written on 4 September as a heads up; this part is the actual handoff. Where the two
disagree, this part wins.

The catalog holds **89,117 games**, with alternative titles so `botw`, `gta v` and
`bg3` resolve. Two endpoints are live and verified end to end against a real signed
token.

**Base URL:** `https://sbunhrxwhraigwpidbxk.supabase.co/functions/v1`

- `GET /search?q=elden ring` → `CatalogGame[]`, at most 10
- `GET /games/<uuid>` → `CatalogGame`

Both require a logged-in user. Without a token they return 401, so the URL on its own
will not get you anything — the session has to come first. That is the main piece of
work on your side and I go through it below.

## 1. What the app needs before it can call anything

There is no Supabase wiring in the app repo at all right now — no `@supabase/supabase-js`
in `package.json`, no reference to it in `src/`, and `src/config/env.ts` only carries the
RevenueCat keys. So:

```sh
npx expo install @supabase/supabase-js @react-native-async-storage/async-storage
```

AsyncStorage you already have. The client wants it for session persistence:

```ts
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,   // required on React Native
  },
});
```

Then `searchCatalog` becomes:

```ts
export async function searchCatalog(query: string): Promise<CatalogGame[]> {
  const { data, error } = await supabase.functions.invoke(`search?q=${encodeURIComponent(query)}`, {
    method: 'GET',
  });
  if (error) throw error;
  return data;
}
```

`functions.invoke` attaches the current session's token for you. If you'd rather use
`fetch` directly, you need both an `apikey` header and `Authorization: Bearer <token>`.

I will send you the URL and the anon key separately rather than put the key in a doc
that gets forwarded. The anon key is safe to ship in the bundle — it is meant to be
public and RLS is what actually protects the data — but I would still rather hand it
over directly.

## 2. You are not blocked on Josh for this

Google and Apple sign-in need accounts that are Josh's, and that is still outstanding.
But **email and password sign-in is enabled on the project today**, so you can build
and test the whole session flow now:

```ts
await supabase.auth.signInWithPassword({ email, password });
```

Switching to Google or Apple later changes who mints the identity. It does not change
the shape of the token, how the endpoints read it, or any of the code above. So the
plumbing you write against email/password is the plumbing that ships. Please do not
wait on the providers to start this.

## 3. What actually comes back

This is a real response from the deployed endpoint, not a sketch:

```json
{
  "id": "fc9cd9c2-aa68-42c0-9226-33cf6c4bcdef",
  "title": "Elden Ring",
  "slug": "elden-ring",
  "platforms": [
    { "id": 508, "name": "Nintendo Switch 2",      "slug": "switch-2"   },
    { "id": 6,   "name": "PC (Microsoft Windows)", "slug": "win"        },
    { "id": 48,  "name": "PlayStation 4",          "slug": "ps4--1"     },
    { "id": 167, "name": "PlayStation 5",          "slug": "ps5"        },
    { "id": 49,  "name": "Xbox One",               "slug": "xboxone"    },
    { "id": 169, "name": "Xbox Series X|S",        "slug": "series-x-s" }
  ],
  "releaseDate": "2022-02-25",
  "genres": ["Role-playing (RPG)", "Adventure"],
  "coverImageUrl": "https://images.igdb.com/igdb/image/upload/t_cover_big_2x/co4jni.jpg",
  "timeToBeatHours": 119.4,
  "sessionFit": "low",
  "criticScore": 97,
  "abbreviation": "ER",
  "colorKey": "red"
}
```

Six platforms, which is the thing `platform: string` could never hold.

`slug` is new since the 4 September draft — stable and readable, so share links can use
it instead of the uuid. `id` is still the thing to key on.

Fields that can be absent: `releaseDate`, `coverImageUrl`, `timeToBeatHours`,
`sessionFit`, `criticScore`, `slug`. Only about 5% of games have a time to beat, so
treat that as usually missing rather than usually present.

## 3b. The popular endpoint you asked for — live now

`GET /games/popular` is deployed and returns the same `CatalogGame[]` as everything
else, so it needs no new type on your side:

```ts
export async function popularGames(limit = 20, offset = 0): Promise<CatalogGame[]> {
  const { data, error } = await supabase.functions.invoke(
    `games/popular?limit=${limit}&offset=${offset}`, { method: 'GET' },
  );
  if (error) throw error;
  return data;
}
```

`limit` defaults to 20 and is capped at 100; `offset` pages. Paging past the end
gives `[]`, not an error, and paging is stable — a row cannot be dropped or repeated
between pages.

**What "popular" means here.** It is ordered by IGDB's count of *user ratings*, so it
is a measure of how widely played something is, not how good it is. That is a
different number from `criticScore` — a game can be widely played and mediocre, or
acclaimed and obscure. The count itself is **not** in the response: the ordering is
the contract, so I can re-tune it without breaking your screens.

**The list is finite: 15,948 games**, out of 89,117 in the catalog. The other 73,169
have no ratings at all and are excluded deliberately — they are not "less popular
games", they are rows with no signal, and including them would put something random
on page 4. So do not build a UI that assumes infinite scroll; it ends.

The top of the list, for what to expect: Grand Theft Auto V, The Witcher 3, Portal 2,
Skyrim, GTA: San Andreas, Portal, Red Dead Redemption 2, God of War.

**Search ranking improved at the same time**, off the same data — you do not have to
do anything, results just get better. Searching `cyberpunk` used to return *Cyberpunk
SFX* and *Cyberpunk Sex* above *Cyberpunk 2077*, because the old ranking favoured
short titles. It now returns Cyberpunk 2077 first. Two known cases are still not
right — `zelda botw` and `dragonsdogma2` return a near-miss first — but both are in
the top 5, and both are a different bug that I will fix separately.

## 4. Where your type and mine differ, and who wins

I went through the app repo properly this time rather than guessing. The rule I used:
**I own anything derived from IGDB data, you own anything that is a design decision.**

| Field | Winner | Note |
| --- | --- | --- |
| `platforms[]` vs `platform` | mine | Six platforms on Elden Ring. Pick one for the row subtitle, or let people choose which they own. |
| `genres[]` vs `genre` | mine | `genres[0]` if you just need one. |
| `releaseDate` vs `year` | mine | `year` is required in your type but plenty of games have no date at all. Derive it: `new Date(releaseDate).getFullYear()`. |
| `id` uuid vs `'elden-ring'` | mine | Has to match the database key, see below. |
| `abbreviation` | mine | Can't hand-type 89,117 of them. |
| **`colorKey`** | **yours** | Mine was a placeholder I invented. Yours are real design values, so I took yours. |
| `pcRequirements` | neither | Still does not exist in IGDB. |

**On `colorKey`, I owe you a heads up.** I was emitting `amber, rose, violet, indigo,
teal, emerald, slate`. Your `coverColors` in `theme.ts` knows `teal, orange, purple,
pink, gold, navy, red, green, blue, slate`. Only two of them overlapped. `GameCover.tsx`
resolves an unknown key as `coverColors[colorKey] ?? coverColors.slate`, so five of my
seven keys would have come through as the same grey, with no error anywhere to tell
either of us. Fixed — I emit your ten now, and my verification pins every emitted key to
that declared list, so it cannot drift silently on my side. It cannot see your
`theme.ts`, though, so if you rename or drop a colour there, tell me and I will change
mine to match. Worth knowing because it is exactly the kind of bug that survives to
demo day.

**Answering my own open question 1 from 4 September:** I checked, and yes,
`pcRequirements` is being used — `GameDetailScreen.tsx` renders a minimum/recommended
block from it. IGDB has no such data, so that section needs to come out or find another
source. Sorry, that one is on me for putting it in the mock shape originally.

## 5. Three things that are your call

**`id` changes from slug to uuid, and that touches stored data.** Your library and
wishlist stores persist `catalogId` into AsyncStorage, and those are currently strings
like `'elden-ring'`. They have to become uuids, because `library_entries.game_id` points
at the real games table. Simplest is to clear local state once during the switch, since
this is all dev data. If you would rather migrate it, I can give you a slug → uuid
lookup. Your mock ids look like IGDB slugs and many will match outright, but not all —
IGDB has `hades-ii` where yours says `hades-2` — so that migration would need a
by-hand pass over the stragglers. Clearing local state is genuinely the cheaper option.

**`releaseDate` means something different now.** In your catalog its presence means "not
out yet", and `useWishlistStore` uses it to decide whether to schedule a reminder. I send
it for every game that has a date, past or future. Nothing breaks today —
`scheduleReleaseReminder` already no-ops on a past date, which is good defensive code —
but I would swap the flag for `releaseDate > today` so it says what it means.

**The abbreviations get longer.** Mine takes up to three initials, so *Return of the Obra
Dinn* is `ROD` where yours was `RO`, and *Hollow Knight: Silksong* is `HKS`. In a 48px
swatch three characters may be tight. Say the word and I will cap it at two.

## 6. What I still need from you

For the Google and Apple sign-in setup, none of which is written down anywhere:

- ~~Android package name~~ — got it, 8 Sep: `com.nathanakin.revenuecatgame`
- ~~Android signing SHA-1 fingerprint~~ — got it, 8 Sep, from `android/app/debug.keystore`
- iOS bundle identifier — Josh says use a placeholder, which is fine for now
- the deep link scheme you want

**Two things about what you sent, both worth acting on before 30 Sep.** Details in
`docs/auth-setup.md`; the short version:

**The package name is still the scaffold's.** `com.nathanakin.revenuecatgame` is
someone else's namespace naming a different app — it came in with whatever RevenueCat
sample the project started from. It cannot be changed after the first Play Store
upload; Google treats a changed application ID as a brand new app, so you lose the
listing, installs and reviews. Right now it is one line in `app.json`. Could you pick
a real one — `com.shelfapp.shelf`, or the reverse of whatever domain Josh registers —
and use the **same namespace for the iOS bundle ID**? That way Josh registers the
Apple App ID once instead of twice, and the Google OAuth clients get created once.
This is the reason it is worth doing this week rather than at the end.

**That SHA-1 is the debug one, and it is a shared public value.** It is the
checked-in React Native template `debug.keystore` (`CN=Android Debug`, serial
`232eae62`) — identical in every project built from that template, not unique to you.
Perfectly fine for the dev OAuth client, and it unblocks you today. But the release
build has a *different* fingerprint, and if the Play listing uses Play App Signing
(the default), the one Google has to trust is the app signing certificate that only
appears in Play Console after the first upload. Both go on the same Android OAuth
client. Worth knowing now so that "Google sign-in works on my machine but not in the
release build" isn't a surprise during review week.

**And one product decision, worth settling before you build the sign-in screen.**
Supabase only links a second sign-in method to an existing account when the email
matches. Apple's Hide My Email hands out a `@privaterelay.appleid.com` address, which
will never match someone's Google address. So one person signing in with Google on
Android and Apple on iOS gets two separate accounts, and their whole library looks like
it vanished — no error, nothing to debug from the app side. App Store guideline 4.8
requires us to offer the email-privacy option, so this is the path Apple actively pushes
people down. Cheapest fix is one provider per platform: Apple on iOS, Google on Android.
That is a UI decision more than a backend one, which is why it is yours.

## 7. If you want to see it working

Everything above is verified — `npm run verify:functions` on my side runs 29 checks
against the deployed URLs, including auth rejection, response shape and a real search.
`elden ring` comes back first. Search ranking is not perfect yet on shorter queries
(`cyberpunk` currently puts some shovelware above Cyberpunk 2077) and I have a fix
planned; it does not change the contract, so it should not hold you up.

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
