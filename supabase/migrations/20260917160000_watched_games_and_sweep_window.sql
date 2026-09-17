-- Two gaps left by Session B of the Events build (20260917120000/130000), found
-- reviewing it on 17 Sep.
--
-- ---------------------------------------------------------------------------
-- 1. The Events screen had no list to render
-- ---------------------------------------------------------------------------
-- Sola's note describes the screen as "a date-sorted list of upcoming releases
-- (reuses the existing game-row component)". What shipped was the per-game half:
-- a watch toggle on /games/:id and a notification on release day. Nothing returned
-- the games a user watches.
--
-- The app CAN read game_watches straight through PostgREST -- that is the whole
-- reason it has no toggle endpoint -- but a watch row is (user_id, game_id,
-- created_at), so rendering it means joining `games` client-side, and a game read
-- that way carries no `abbreviation` and no `colorKey`: both are derived in
-- toCatalogGame(), not stored. GameCover.tsx resolves a missing colorKey as
-- `coverColors[colorKey] ?? coverColors.slate`, so every cover on the Events
-- screen would render the same grey with no error on either side -- the exact
-- drift documented in _shared/catalog-game.ts that already cost this project once.
-- So the list is a catalog-shaped RPC like the other three, behind /games/watching.
--
-- NOT AN "EVERYTHING RELEASING THIS MONTH" FEED. docs/research/events-screen.md §1c
-- measured why that cannot ship as-is: nothing upcoming can be ranked
-- (total_rating_count is 0 on all 3,748 upcoming rows, structurally -- IGDB user
-- ratings accrue after release), so a date-sorted browse of the whole catalog
-- leads with shovelware. A curation gate is still an open product question; this
-- function answers only "the games THIS user chose to watch", which needs no gate.
create or replace function shelf_watched_games(max_results int default 20, p_offset int default 0)
returns table (
  id                 uuid,
  title              text,
  slug               text,
  release_date       date,
  genres             text[],
  cover_url          text,
  critic_score       smallint,
  ttb_normally_hours numeric,
  ttb_count          int,
  session_fit        text,
  platforms          jsonb,
  score              real,
  release_precision  text,
  watched_at         timestamptz,
  watcher_count      bigint
)
language sql
stable
set search_path = public, extensions
as $$
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         null::real,
         g.release_precision,
         gw.created_at,
         -- Inline rather than calling shelf_game_watcher_count per row: this
         -- function is SECURITY INVOKER and game_watches is "own rows only", so a
         -- plain count here would answer 1 every time. The subquery runs as the
         -- DEFINER function does, through the same game_watches_game index, and
         -- returns a number, never an identity -- the same reason that function is
         -- safe (20260917120000).
         (select count(*) from game_watches w where w.game_id = g.id)
    from game_watches gw
    join games g on g.id = gw.game_id
   -- RLS already scopes this to the caller; the predicate is what lets the planner
   -- use game_watches' primary key instead of filtering after the join, same as
   -- shelf_recently_viewed.
   where gw.user_id = (select auth.uid())
   -- Upcoming first, soonest first -- the screen is "what am I waiting for". Games
   -- that have already come out fall below, most recent first, so a watch does not
   -- silently vanish the morning it ships. Undated games sort with the upcoming
   -- ones because "no date yet" is a thing you are still waiting for.
   order by (g.release_date is not null and g.release_date < current_date),
            case when g.release_date >= current_date then g.release_date end asc nulls last,
            case when g.release_date <  current_date then g.release_date end desc,
            g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

revoke all on function shelf_watched_games(int, int) from public, anon;
grant execute on function shelf_watched_games(int, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. A missed sweep used to mean a permanently missed release
-- ---------------------------------------------------------------------------
-- The original matched `release_date = current_date` exactly, which is correct
-- only if the sweep runs on every single calendar day forever. It has never run
-- on any: nothing schedules it yet (pg_cron is not installed on this project --
-- see the function header for why its schedule is deliberately not in a
-- migration). One missed day -- a failed cron run, an outage, the day the
-- schedule is finally switched on -- and every watcher of that day's releases is
-- silently owed a bell that can never arrive.
--
-- A 2-day trailing window fixes that, and is safe only because of the dedupe
-- index: notifications_dedupe collapses to (user_id, kind, game_id) for this
-- kind, so re-seeing the same game on three consecutive runs still writes exactly
-- one row per watcher, ever. Chosen over a wider window because the first run
-- after the schedule goes live will notify for everything inside it, and "out in
-- the last couple of days" is still true; "out last week" reads as a bug.
--
-- release_precision = 'day' is unchanged and is still the point: anything less
-- precise means the date is IGDB's end-of-period placeholder, not an announcement.
create or replace function shelf_sweep_game_releases()
returns int
language sql
volatile
security definer
set search_path = public
as $$
  with due as (
    select id as game_id
      from games
     where release_date between current_date - 2 and current_date
       and release_precision = 'day'
  ),
  ins as (
    insert into notifications (user_id, actor_id, kind, game_id)
    select gw.user_id, null, 'game_release', d.game_id
      from due d
      join game_watches gw on gw.game_id = d.game_id
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins;
$$;

revoke all on function shelf_sweep_game_releases() from public, anon, authenticated;
