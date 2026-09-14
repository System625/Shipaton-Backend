-- Account linking: the connection itself, the redirect handshake it needs, and the
-- two import defects that are schema rather than code.
-- Source: docs/research/account-linking.md sections 8b/8c, 9 and 10.
--
-- APPLE 4.8, stated here because the schema is what enforces it. A row in this
-- table belongs to a user_id that already exists in auth.users. There is no path
-- from "I have a Steam account" to "I have a Shelf account": linking a platform is
-- something you do *inside* a signed-in session. Guideline 4.8 binds third-party
-- login used "to set up or authenticate the user's primary account", so keeping
-- these as connections keeps Sign in with Apple out of scope entirely. If anyone
-- ever proposes a "Sign in with Steam" button, this is the comment to re-read.

create table platform_accounts (
  user_id        uuid not null references auth.users(id) on delete cascade,
  -- 'psn' is absent: PlayStation is deliberately not built (section 5 — the NPSSO
  -- is password-equivalent and the UX is bad on mobile). It goes in when it ships,
  -- not before, so this list never claims a connection that does not exist.
  platform       text not null check (platform in ('steam','xbox')),

  -- SteamID64 for Steam, XUID for Xbox. Public identifiers, not credentials.
  -- NOTHING SECRET IS STORED HERE, and that is deliberate rather than incidental:
  -- Steam's OpenID hands back an identity and no token at all, and OpenXBL's
  -- delegated flow gives a per-user key we use once and discard. When PlayStation
  -- arrives it brings the only real credential in the system (a refresh token), and
  -- section 5 is explicit that the NPSSO it came from must never be written to a
  -- table, a log line, or a query string.
  external_id    text not null,
  display_name   text,
  avatar_url     text,

  linked_at      timestamptz not null default now(),
  last_import_at timestamptz,
  -- What the last import actually did, so the app can say "412 of 468 games matched"
  -- instead of "done". The gap is the honest part: 12% of a Steam library does not
  -- reach our catalog and the user should be told so, not left to notice.
  last_import_total    int,
  last_import_matched  int,

  primary key (user_id, platform)
);

-- One Steam account must not be linked to two Shelf accounts: the import would be
-- correct for both, but "connected" would stop meaning anything and a disconnect
-- would read as if it had failed.
create unique index platform_accounts_external on platform_accounts (platform, external_id);

alter table platform_accounts enable row level security;

create policy "own platform accounts"
  on platform_accounts for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


-- The redirect handshake.
--
-- THE PROBLEM THIS SOLVES: Steam's OpenID callback arrives as a browser redirect
-- from Steam's servers. It carries no Authorization header, so the endpoint that
-- receives it cannot know which Shelf user it is for. A `state` parameter naming
-- the user would be attacker-controlled — anyone could bind their own Steam account
-- to somebody else's library. So the binding is issued server-side, from an
-- authenticated request, and looked up on the way back.
--
-- WHO TOUCHES THIS TABLE. Issuing a nonce and reading the result back both happen
-- in authenticated requests, so both run under the caller's own JWT and are covered
-- by the owner-only policy below — the same rule as every other user table here.
--
-- The ONE exception is the callback, which arrives from Steam's servers with no JWT
-- and must still record the verified identity against a nonce it cannot see under
-- RLS. That single handler uses the service role, and it is the only service-role
-- use in this backend. It is survivable because of what the row holds: a random
-- single-use nonce, a user id, and a public platform identifier. No credential ever
-- lands here, which is also why section 5's rule for PlayStation — never store the
-- NPSSO, exchange it for tokens inside the request — does not need a column.
create table platform_link_nonces (
  -- 32 random bytes, base64url. Unguessable and single-use: consuming it is what
  -- makes a leaked callback URL worthless on the second click.
  nonce         text primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  platform      text not null check (platform in ('steam','xbox')),

  -- Written by the callback AFTER the platform has confirmed the identity, never
  -- before. For Steam that means after the OpenID `check_authentication` round trip
  -- returned `is_valid:true` — the `claimed_id` in the redirect is worth nothing
  -- until Steam itself says so, and trusting it unverified is account takeover by
  -- impersonation.
  verified_external_id text,
  verified_at   timestamptz,

  created_at    timestamptz not null default now(),
  -- Ten minutes is a sign-in, not a session. An abandoned link attempt expires
  -- rather than sitting there as a live binding.
  expires_at    timestamptz not null default now() + interval '10 minutes',
  consumed_at   timestamptz
);

create index platform_link_nonces_user on platform_link_nonces (user_id);

alter table platform_link_nonces enable row level security;

-- Own rows only. A user can mint a nonce for themselves and read back what the
-- callback recorded against it; they can never see or claim anybody else's. The
-- callback's service-role client bypasses this entirely, which is the point.
create policy "own link nonces"
  on platform_link_nonces for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


-- 8c: imported rows need their own provenance.
--
-- Without this an imported row is indistinguishable from one the user typed, which
-- breaks the disconnect promise in section 9 rule 2 ("a disconnect button that
-- actually deletes") — we would not know what to delete.
--
-- FOR THE APP, and this is the same trap the wishlist migration called out: the
-- client types source_kind as a closed set. Two new values can now arrive on rows
-- the app already syncs. 'psn' is included here even though PlayStation is not
-- built, because widening a check constraint later is a migration and a redeploy,
-- while an app that already tolerates the value costs nothing today.
alter table library_entries drop constraint library_entries_source_kind_check;
alter table library_entries add constraint library_entries_source_kind_check
  check (source_kind in ('tiktok','youtube','search','manual','steam','xbox','psn'));

-- Which import a row came from, so a re-import can recognise its own work and a
-- disconnect can remove exactly it. Null on everything that was not imported.
alter table library_entries add column imported_uid text;

-- 8a IS NOT HERE, and that is the decision rather than an omission.
-- `hours_played numeric(5,1)` maxes out at 9,999.9 and Steam returns minutes, so a
-- 10,000-hour Dota player overflows it and takes the whole batch page with them —
-- the exact shape of the failure that killed the first catalog seed. The fix is to
-- CLAMP ON THE WAY IN, the way mapping.ts already clamps ttb_*_hours, not to widen
-- the column: a clamped 9,999.9 is honest enough, and a failed import is not.
-- See steamPlaytimeHours() in supabase/functions/_shared/platform-import.ts.


-- Disconnect, and it means it.
--
-- Deletes the connection and every library row that import created, in one
-- transaction. What it must NOT do is touch a row the user has since made their
-- own, which is why the delete is narrowed to rows still carrying the import's
-- provenance: change the status, rate it, write a note, and it is yours to keep.
create or replace function shelf_disconnect_platform(p_platform text)
returns table (removed_entries int)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_removed int;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  -- Guard the argument, because this function deletes rows by source_kind and the
  -- argument IS the source_kind. Called with 'manual' it would delete every game
  -- the user added by hand and had not yet touched. Callers are trusted; a typo is
  -- not.
  if p_platform not in ('steam','xbox','psn') then
    raise exception 'unknown platform: %', p_platform;
  end if;

  with gone as (
    delete from library_entries
    where user_id = v_user
      and source_kind = p_platform
      -- Untouched since the import wrote it: still in the status the import chose,
      -- never rated, never annotated.
      and status = 'backlog'
      and rating is null
      and notes = ''
      and finished_at is null
    returning 1
  )
  select count(*)::int into v_removed from gone;

  delete from platform_accounts
  where user_id = v_user and platform = p_platform;

  -- Rows the user edited stay, but stop claiming to come from a connection that no
  -- longer exists. The game remains in the library; only the provenance is cleared.
  update library_entries
  set source_kind = 'manual', imported_uid = null
  where user_id = v_user and source_kind = p_platform;

  return query select v_removed;
end;
$$;

revoke all on function shelf_disconnect_platform(text) from public, anon;
grant execute on function shelf_disconnect_platform(text) to authenticated;
