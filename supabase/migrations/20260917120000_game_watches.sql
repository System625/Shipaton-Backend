-- game_watches: "notify me when this releases," the toggle behind the Release-Day
-- Tracker -- Session B of the Events screen build (decision 17 Sep 2026,
-- docs/research/events-screen.md §4). Session A landed first on purpose:
-- release_precision (20260917100000) is what lets the sweep in the next migration
-- tell an announced release day from IGDB's end-of-period placeholder. Reversed,
-- this gets built twice against data that isn't honest yet.
--
-- A TABLE, NOT AN EDGE FUNCTION. Same shape as wishlist_entries and follows: the
-- app reads and writes this straight through PostgREST, and the only thing that
-- has to be correct is the policy below. No toggle endpoint exists to write,
-- because none is needed.

create table game_watches (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  game_id    uuid not null references games(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The pair is the key: watching a game twice is a 23505, not a second row, same
  -- as wishlist_entries.
  primary key (user_id, game_id)
);

-- The primary key covers "games I watch"; this is the reverse direction --
-- watcher_count below, and the release sweep's join, both go through game_id.
create index game_watches_game on game_watches (game_id);

alter table game_watches enable row level security;

create policy "own game watches"
  on game_watches for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- The one thing the policy above cannot answer: how many people, in total, watch a
-- game. "Own rows only" means a plain count() through PostgREST returns 0 or 1 --
-- the caller's own row -- never the real total. SECURITY DEFINER to read across
-- every row is safe here for the same reason shelf_popular_with_friends is safe
-- and shelf_blocked_between was not (20260908214500): this takes a GAME id, not a
-- user id, and returns a COUNT, never an identity. Nothing it returns says who is
-- watching, only how many.
create or replace function shelf_game_watcher_count(p_game_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*) from game_watches where game_id = p_game_id;
$$;

revoke all on function shelf_game_watcher_count(uuid) from public, anon;
grant execute on function shelf_game_watcher_count(uuid) to authenticated;
