-- The wishlist: games a user wants but has not got. The app's "Saved" shelf.
--
-- Until now it existed only on the phone. The app's `useWishlistStore` is zustand +
-- AsyncStorage, so "Explore Saved" and the Wishlist tab are lost on reinstall, never
-- reach a second device, and are shared between every account that signs in on the
-- same phone. The library moved to the server on 10 Sep (app commit cfa0909); this is
-- the same move for the other half of what a user keeps.
--
-- A TABLE OF ITS OWN, NOT A FIFTH `library_entries.status`. Tempting, since the
-- popular-with-friends migration already calls 'backlog' "a wishlist in all but name",
-- but it breaks three things that exist today:
--
--   1. The app's library sync reads every `library_entries` row with no status filter
--      and types `status` as the four values. A 'wishlist' row would land in the
--      Library as a status the app cannot render -- and, like colorKey, nothing on
--      either side would report it.
--   2. The app counts library rows against FREE_TIER_GAME_LIMIT (50). Saving a game
--      you do not own would eat into the paid limit.
--   3. `unique (user_id, game_id)` would make a game either saved or owned, never
--      both, and the app lets it be both.
--
-- It also carries something the library has no column for: whether the release
-- reminder is armed.
--
-- PRIVACY: owner-only, exactly like `library_entries`. What someone wants but has not
-- bought is shelf data, not feed data, and the line drawn in the social-graph
-- migration does not move here.

create table wishlist_entries (
  -- Defaults to the caller, so the app can insert just { game_id }. The policy below
  -- still refuses any explicit user_id that is not theirs.
  user_id          uuid not null default auth.uid() references auth.users(id) on delete cascade,
  game_id          uuid not null references games(id),
  -- The reminder itself is a LOCAL notification scheduled by the app
  -- (expo-notifications). This only records the user's choice, so a reinstall or a
  -- second device knows which reminders to re-arm.
  reminder_enabled boolean not null default true,
  added_at         timestamptz not null default now(),
  -- The pair is the key, so saving a game twice is a 23505, not a second row.
  primary key (user_id, game_id)
);

-- The primary key covers lookups by user; this is the reverse direction, for the same
-- linter rule migrations 000800 and 20260909075500 exist for.
create index wishlist_entries_game on wishlist_entries (game_id);

alter table wishlist_entries enable row level security;

create policy "own wishlist entries"
  on wishlist_entries for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
