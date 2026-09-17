# Push notifications via OneSignal

Raised by Sola around 15 Sep 2026. Checked against OneSignal's live docs the same
day, not from memory — see the sources at the bottom.

## The headline: OneSignal does not remove the blocker

Push was descoped on 9 Sep because of APNs and FCM credentials. **OneSignal still
requires both** — their own docs say push "will not deliver until APNs credentials
are configured," and likewise for FCM. It is a delivery and targeting layer *on top
of* APNs/FCM, not a replacement, so it does **not** route around Josh. What it
genuinely removes is the device-token table and the per-platform send logic, which
was already the smaller half of the work and already backend's to build.

Split: **sending is backend, receiving is the app, credentials are Josh's.**

## What's needed from Josh — the entire critical path

1. Apple Developer Program membership, if not already active.
2. An **APNs `.p8` auth key** from that account, uploaded to the OneSignal
   dashboard.
3. A **Firebase project** + its **FCM Service Account JSON**, uploaded to
   OneSignal.
4. A OneSignal account, an **App ID**, and a **REST API key**. Pricing/free-tier
   ceiling was unverified as of 15 Sep — check before committing, given how
   OpenXBL's shared 150 req/hour tier bit us
   (`docs/research/account-linking.md` §4).

There is no ordering trap left here: the app's package name is permanently
`com.nathanakin.revenuecatgame` on both stores (locked by the Play Console record
and the App Store Connect / TestFlight record), so Josh can do 1–4 in any order.

## What's needed from Sola — the app

5. OneSignal RN SDK: a native module, so a new prebuild and a fresh
   TestFlight/internal build to test. Not a blocker as such (the app is already
   prebuilt) but not JS-only.
6. iOS native target work: Push Notifications + Background Modes capabilities, a
   **Notification Service Extension** target, and an **App Group**. Real Xcode
   changes.
7. `OneSignal.login(<supabase user id>)` on sign-in, logout on sign-out. This is
   what makes `external_id` targeting work and is why there is no device-token
   table on the backend.
8. A permission prompt and a settings toggle.

## What's built — backend, 15 Sep 2026

The `notifications` table and its three notify triggers (follow, post_like,
post_comment) already existed
(`20260909121000_notifications.sql`); nothing about the inbox changes for push to
land on top of it.

**`20260915160000_push_pushed_at.sql`:**

- **`pushed_at timestamptz`** on `notifications`. The existing `notifications_dedupe`
  index stops duplicate *bell rows* (unfollow/refollow does not ring the bell
  twice); it says nothing about duplicate *sends*. A retried or overlapping sweep
  would double-push without this column to check first — it is also the sweep's
  entire read query: `where pushed_at is null`.
- A partial index, `notifications_unpushed`, on the same predicate — the same shape
  as `notifications_unread`, for the same reason: the unswept set stays small if
  the sweep runs often enough, however large the table gets.
- **`shelf_next_push_batch(p_limit)`**: the notifications-join-profiles read the
  sweep needs. In SQL rather than a PostgREST embed because there is no direct FK
  from `notifications` to `profiles` to embed through — both point at
  `auth.users` independently, the same reason `shelf_notifications()` (the inbox
  RPC, same file as the table) does this join in SQL. **Revoked from every role but
  the service role**, since it reads across every user's notifications and names
  other people's actors.

**The firing decision (item 12): a scheduled sweep, not fire-on-insert.**

1. The three notify triggers run `SECURITY DEFINER` inside the same transaction as
   the like/follow/comment itself. An external HTTP call from inside that
   transaction means a slow or down OneSignal blocks or fails the user's actual
   action — liking a post must never depend on a third party's uptime.
2. One code path to secure and test, instead of three call sites wired into
   triggers that already do real work.
3. `pushed_at` is a natural, idempotent retry marker for a sweep in a way it is not
   for a fire-and-forget call: a sweep that dies partway through just picks up the
   unpushed rows again next run.

The cost is latency — up to one sweep interval before a push goes out — which is
the right trade for a "so-and-so followed you" notification, not a chat message.

**`supabase/functions/_shared/onesignal.ts`** — the OneSignal call itself.
`include_aliases.external_id` / `headings` / `contents` / `Authorization: Key
<REST key>` / a required `app_id` in the body, checked against
`documentation.onesignal.com/reference/create-message` on 15 Sep, not assumed. One
call per notification rather than a batch: `include_aliases` can target many
recipients in one call, but only with *identical* content, and every row here says
something different (who did what) — there is nothing to batch, only to decouple,
which the sweep does at its own level.

**`supabase/functions/push-sweep/index.ts`** — the worker (item 10). Reads a batch
via `shelf_next_push_batch`, builds copy per `kind`, sends, marks `pushed_at` on
success and leaves a row alone on failure (the next sweep retries it — a OneSignal
5xx must never silently drop a notification). **Not a user-facing endpoint**: it
checks the caller's `Authorization` header against the project's own service role
key rather than resolving a user from it, since nobody has a legitimate reason to
trigger a sweep from the app, and it would let anyone force-send everything
pending or hammer OneSignal's rate limit.

**If `ONESIGNAL_REST_API_KEY` / `ONESIGNAL_APP_ID` are unset** (true as of 15 Sep —
Josh has not sent them), the function reports `{swept: 0, sent: 0, failed: 0}`
rather than erroring. A cron schedule wired up ahead of the keys just idles
harmlessly instead of alerting on every run.

## What's NOT built: the pg_cron schedule

Deliberately not a migration. Wiring pg_cron to call `push-sweep` needs a
service-role-equivalent credential inside Postgres (so `pg_net` can put it in the
`Authorization` header), and a migration file is a file in this git history — the
exact mistake the `.env`-vs-secrets discipline elsewhere in this project exists to
avoid.

**WHICH KEY, EXACTLY — confirmed live 17 Sep 2026 while wiring the same pattern for
`game-release-sweep` (Events Session B), the hard way.** This project has BOTH
Supabase key systems active at once. Inside a deployed edge function,
`Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")` returns the **new-format secret key**
(`sb_secret_...`, ~41 chars) — NOT the legacy `service_role` JWT
(`eyJhbGci...`, ~200+ chars, three dot-separated parts) that `.env` holds and every
verify script in this repo authenticates with. `push-sweep`'s auth check compares
the caller's bearer against that same env var, so **the secret pasted into Vault
below must be the new-format key, not the one in `.env`.** Pasting the legacy JWT
here (the natural reading of "service role key," and what bit `game-release-sweep`
on the first real test) makes every cron-triggered call 401 forever, with nothing
in `cron.job_run_details` louder than a failed HTTP status — easy to wire, deploy,
and walk away from without ever noticing it never worked. Get the new-format key
from the dashboard's API Keys page (a different value than the "service_role" JWT
shown in the legacy keys section).

**Run this once, by hand, via the Supabase SQL editor — after `ONESIGNAL_REST_API_KEY`
and `ONESIGNAL_APP_ID` are set as function secrets.** Checked against
`supabase.com/docs/guides/functions/schedule-functions` on 15 Sep 2026:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- supabase_vault is already installed on this project. Paste the NEW-FORMAT
-- secret key (sb_secret_..., Settings -> API Keys in the dashboard) -- see the
-- warning above. NOT the legacy service_role JWT, and not the anon key either.
select vault.create_secret('<paste the new-format secret key>', 'push_sweep_service_key');

select cron.schedule(
  'push-sweep',
  '* * * * *',  -- every minute; tune once real send volume is known
  $$
  select net.http_post(
    url := 'https://sbunhrxwhraigwpidbxk.supabase.co/functions/v1/push-sweep',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'push_sweep_service_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);
```

To stop it: `select cron.unschedule('push-sweep');`. To watch it run:
`select * from cron.job_run_details order by start_time desc limit 20;`.

## Status 15 Sep 2026 (evening)

Backend groundwork (items 10, 12, 13) is built and deployable now; item 11 (the
REST key as a secret) and the cron wiring above are the two things actually
blocked on Josh. A paste-ready credentials ask for Josh, covering this section's
items 1–4, is still not written as its own message — it exists reproduced in V4 of
the Sola punch-list reply artifact.

Sources: `documentation.onesignal.com` — `docs/ios-sdk-setup`,
`docs/android-sdk-setup`, `reference/create-message`; `supabase.com/docs/guides/functions/schedule-functions`.
