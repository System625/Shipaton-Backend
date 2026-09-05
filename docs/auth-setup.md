# Auth setup

**Written 5 September 2026.** Companion to `docs/STATUS.md` step 6. Everything
below about provider requirements was checked against Supabase's own auth guides on
5 Sep, not recalled — where the repo's earlier notes disagree, this file is the
correction and says so explicitly.

The backend implements no auth by design. `_shared/http.ts` builds a Supabase client
from the caller's JWT and lets RLS apply, so **Supabase Auth is the auth server** and
there is no login endpoint in this repo. What this repo owns is provider
configuration and the verification below. Sign-in UI, session storage and deep links
belong in Sola's app.

---

## What is done

**The real-JWT RLS check — the one thing STATUS step 6 left open.** Run it:

```sh
npm run verify:auth
```

`scripts/verify-auth-rls.ts` creates two users, signs them both in, and drives every
check through the tokens GoTrue actually issues, building clients exactly the way
`_shared/http.ts` builds them. It removes its users and fixtures afterwards, so the
catalog goes back to empty and it is safe to re-run.

This closes the gap the earlier check left. Step 3's version simulated a session with
`set_config('request.jwt.claims', ...)`, which exercises the policies but never
touches a signature, GoTrue, or PostgREST's claim parsing. All 18 checks pass:

| Group | What it establishes |
|---|---|
| Token shape | Real `ES256` signature with a `kid`, `sub` = the user, `role=authenticated`, a live `session_id`, `aal1`, an `exp` |
| Edge-function path | `supabase.auth.getUser()` — the exact call `http.ts` makes — resolves the caller, and a token with one tampered byte is rejected |
| Catalog | `authenticated` reads it; `anon` gets nothing |
| Ownership | A inserts and reads its own `library_entries` row |
| Isolation | B cannot read, update or delete A's rows, and cannot insert a row owned by A (`42501`) |
| `shelf_roulette` | A rolls its own backlog; B passing A's uuid gets nothing; `anon` has EXECUTE on neither function (`42501`) |

**It is provider-agnostic, and that is the point.** Google or Apple change who mints
the identity, not the shape of the JWT or how RLS reads it. Re-run it after the
providers are on, but nothing in it should need editing.

**Do not disable the email provider** to make the project social-only without first
reworking this script — it signs in with a password, and turning email off breaks the
only unattended way to prove RLS still holds.

### One trap: the project signs with asymmetric keys

`/auth/v1/.well-known/jwks.json` serves a single `ES256` EC key. Tokens are **not**
HS256-signed with the legacy JWT secret. Nothing in this repo verifies signatures by
hand — `getUser()` and `verify_jwt = true` both handle it — but anything that starts
doing so must fetch JWKS. Reaching for a shared secret will fail with a signature
error that reads like a bad token.

---

## The live auth config, as of 5 Sep 2026

Read from `GET /v1/projects/{ref}/config/auth` with a personal access token — 243
keys, of which these are the ones that matter. The public `/auth/v1/settings`
endpoint used earlier shows only a thin slice of this.

| Setting | Value | Verdict |
|---|---|---|
| `jwt_exp` | `3600` | Fine. One hour with rotation on is the right shape for mobile |
| `refresh_token_rotation_enabled` | `true` | Correct, leave |
| `security_refresh_token_reuse_interval` | `10` | Correct — tolerates a retry without opening a replay window |
| `sessions_timebox` / `sessions_inactivity_timeout` | `0` / `0` | No forced re-login. Right for a consumer library app |
| `disable_signup` | `false` | Must stay false or social sign-in cannot create accounts |
| `site_url` | `http://localhost:3000` | **Wrong, but blocked** — see below |
| `uri_allow_list` | `''` | Empty. Needs Sola's scheme |
| `security_manual_linking_enabled` | `true` | **Changed 5 Sep** from `false` — see the Hide My Email trap |
| `password_min_length` | `8` | **Changed 5 Sep** from `6` |
| `password_hibp_enabled` | `false` | Wanted, but Pro-only — see below |
| `security_captcha_enabled` | `false` | Leave off — enabling it breaks `verify:auth`, which cannot solve a captcha |
| `mailer_autoconfirm` | `false` | Fine; `verify:auth` uses admin `email_confirm` and bypasses it |

`site_url` is not merely cosmetic: it is an **implicitly allowed redirect target**.
Pointing it at `localhost:3000` on a project with no web frontend is untidy rather
than dangerous, but it should become the app's deep link once Sola supplies the
scheme. Guessing a scheme now would be worse than leaving it.

Security advisors report exactly one lint, the known INFO on `search_cache` (RLS on,
no policy), which STATUS already documents as the intended locked-down posture. No
new findings.

---

## The trap: Hide My Email splits accounts in two

**This is the one thing on this page that will bite in the product, not the setup.**

Supabase links a new OAuth identity to an existing user **only when the email address
matches**, verbatim from its identity-linking guide:

> Supabase Auth will attempt to look for an existing user that uses the same email
> address. If a match is found, the new identity is linked to the user.

Sign in with Apple offers **Hide My Email**, which issues a relay address like
`a1b2c3@privaterelay.appleid.com`. That never matches the user's Google address. So a
user who signs in with Google, then later taps Apple and chooses to hide their email,
gets **two separate `auth.users` rows** — and because every `library_entries` row is
keyed on `user_id`, their entire shelf appears to vanish. They did nothing wrong and
there is no error to see.

This is not an edge case to be waved away. **Guideline 4.8 is the reason Apple sign-in
is on the table at all, and email privacy is one of the three criteria it requires** —
so the privacy-relay path is the one Apple actively pushes users toward.

Nothing about this is fixable in the backend schema. The mitigations are:

1. ~~Turn on `security_manual_linking_enabled`~~ — **done 5 Sep 2026**, so
   `linkIdentity()` now exists. It was `false`, which meant the recovery path was not
   merely unused but unavailable. This unblocks mitigation 2; it does not fix anything
   on its own.
2. **Sola offers "link another sign-in method" in settings**, calling `linkIdentity()`
   with the ID-token form for native providers.
3. **Failing both, present one provider per platform** — Apple on iOS, Google on
   Android — so the collision is far less likely to arise in the first place. Cheapest
   option, and worth considering given the 30 Sep deadline.

Worth deciding before Sola builds the sign-in screen, because option 3 is a UI
decision and the other two are not.

---

## What is blocked, and on whom

Neither provider is enabled. `GET /auth/v1/settings` on 5 Sep returns `google: false`
and `apple: false`; only `email` is on. Both need accounts that are not ours:

| Needed | From whom | Why it is theirs |
|---|---|---|
| Apple Developer Program membership | **Josh** | Store accounts are Josh's |
| Google Cloud project | **Josh** | Same reason; the OAuth clients live in it |
| iOS bundle identifier, Android package name | **Sola** | Set in the app, not here. Nothing in the repo records them |
| Android signing SHA-1 fingerprint | **Sola** | Comes from the signing keystore / EAS credentials |
| Deep-link scheme | **Sola** | Needed for the redirect allowlist |

The Supabase-side values that do not depend on anyone:

- Project ref `sbunhrxwhraigwpidbxk`
- Callback URL (Apple web/Android OAuth only): `https://sbunhrxwhraigwpidbxk.supabase.co/auth/v1/callback`

---

## Correction: the Apple ask is smaller than STATUS said

STATUS lists Sign in with Apple as needing "membership, Services ID, Team ID, Key ID,
`.p8` key". **That list is only correct for the OAuth flow**, which on this app means
Android. Supabase's Apple guide, on native Expo: *"If you're building a native app
only, you do not need to configure the OAuth settings."* Native iOS needs an App ID
with the Sign in with Apple capability, registered in the provider's **Client IDs**
list — nothing else.

That matters twice over. It removes four of the five things being asked of Josh, and
it removes the **6-month secret rotation**: Apple requires a new secret generated from
the `.p8` every six months, and the same guide confirms *"Native-only implementations
don't require secret key rotation."* On a project that may sit unattended between the
30 Sep deadline and 22 Oct judging, a credential with an expiry is a liability worth
not acquiring.

**The trade-off to decide, not assume:** Sign in with Apple is not native on Android,
so skipping the OAuth config means an account created with Apple on iOS cannot sign
back in on Android. Guideline 4.8 is an App Store rule and does not bind Android, so
this is a cross-platform-convenience question, not a compliance one.

**Recommendation: iOS-native only for now.** Take the smaller ask, and add the
Services ID and `.p8` later if Apple-on-Android turns out to matter. Nothing about
doing it later is harder than doing it now.

---

## The runbook, for when the credentials land

### Google

1. In Josh's Google Cloud project, **Clients → Create OAuth client ID**, three times:
   **iOS** (needs Sola's bundle ID), **Android** (needs the package name and the
   SHA-1 fingerprint — get both the debug and release fingerprints, they differ), and
   **Web**. The Web client is not for a website; the Google Sign-In library uses it
   on Android.
2. Supabase dashboard → Authentication → Providers → Google → enable, and paste all
   three IDs into **Client IDs**, comma-separated, **web first** — the docs are
   explicit about the ordering.
3. Enable **Skip nonce check** for the iOS native flow.
4. No client secret is needed for the native path. The secret belongs to the web
   OAuth flow, which this app does not use.

### Apple (iOS native)

1. In Josh's Apple Developer account, **Identifiers → App ID** for Sola's bundle ID,
   with **Sign in with Apple** enabled in Capabilities. Leave the server-to-server
   notification endpoint blank — Supabase Auth does not support it.
2. Supabase dashboard → Providers → Apple → enable, and add that bundle ID under
   **Client IDs**. Add every build variant Sola uses (`…app`, `…app.dev`,
   `…app.preview`); each is a distinct App ID to Apple.
3. Skip the OAuth settings entirely unless Apple-on-Android is wanted.

### Redirect URLs

Authentication → URL Configuration → add Sola's deep-link scheme
(`shelf://auth/callback` or whatever the app settles on). Strictly this is only load
bearing for browser-redirect flows, and the native paths do not use one — but it costs
nothing and the Android Apple flow would need it.

### Then

```sh
npm run verify:auth        # should still be 18/18
```

and re-run it once Sola can produce a real Google or Apple session, to confirm a
provider-minted identity lands in `auth.users` and hits the same policies.

---

## What Sola needs from this

`signInWithIdToken` for both providers — the native path, not `signInWithOAuth`:

- Apple: `expo-apple-authentication`, and Apple returns the user's full name **only
  on the very first sign-in**. If it is not saved to user metadata at that moment it
  is gone for good, unless the user revokes and re-authorizes. Supabase's guide
  handles this by calling `updateUser` immediately after the first successful sign-in.
- Google: `@react-native-google-signin/google-signin`. The free "GN Google Sign In
  Free" build cannot pass a custom nonce, so it does not work here.

Neither library works in Expo Go, which this project already gave up for
`expo-share-intent` — so that cost is sunk, not new.

---

## Config changes applied 5 Sep 2026

| Setting | Was | Now | How |
|---|---|---|---|
| `security_manual_linking_enabled` | `false` | **`true`** | Dashboard toggle |
| `password_min_length` | `6` | **`8`** | Management API PATCH |
| `password_hibp_enabled` | `false` | `false` — **blocked** | See below |

`verify:auth` re-run after the change: still 18/18.

**Leaked-password protection is a Pro feature.** The PATCH returns `HTTP 402`:
*"Configuring leaked password protection via HaveIBeenPwned.org is available on Pro
Plans and up."* This project is on Free, so it cannot be enabled today.

That is a small extra weight on the **free-vs-Pro decision** already open in STATUS,
not a reason to upgrade on its own — it hardens the email/password fallback, which is
not the product's real sign-in path. If the project moves to Pro for the pause-after-
a-week problem, turn this on at the same time.

## Still open

- **Whether any of this is urgent.** Guideline 4.8 binds at App Store review. If
  distribution inside the contest window is TestFlight or Android, 4.8 does not bite
  before 22 Oct and the Apple work can wait. **Ask Josh what the iOS distribution
  path actually is** — the answer decides the priority, and it is one question.
- **Whether to keep email sign-in enabled in production.** It is on now, `verify:auth`
  depends on it, and it costs nothing. Turning it off is a decision for after the
  providers work, not before.
