-- Recently viewed: the games this user opened, newest first.
--
-- The last backend item on Sola's 15 Sep punch list. The app has a "Recently viewed"
-- rail with nothing behind it; like the wishlist before 11 Sep and the library before
-- 10 Sep, anything it remembered lived in AsyncStorage on one phone.
--
-- PRIVACY: owner-only, and it never becomes feed data. This is a stricter line than
-- the library, not a looser one -- what someone browsed is more revealing than what
-- they own, because it includes everything they looked at and did not add. Nothing
-- here is exposed to followers, aggregated into "popular with friends", or counted
-- anywhere a second person can see. The social-graph migration's line does not move.
--
-- NOT A LIBRARY STATUS, for the same reason the wishlist is not one (20260911221650):
-- the app reads every library_entries row with no status filter and types `status` as
-- four values, so a fifth would render as nothing and report no error. Viewing is also
-- not an intention -- it is the one interaction a user makes without meaning anything
-- by it, which is exactly why it must not touch the 50-game free-tier count.

create table recently_viewed (
  -- Defaults to the caller so a client can insert just { game_id }; the policy below
  -- still refuses any explicit user_id that is not theirs.
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  game_id   uuid not null references games(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  -- The pair is the key: re-opening a game MOVES it to the top rather than adding a
  -- second row. A history of "you viewed Hades, Hades, Hades" is not a rail anyone
  -- wants, and it is what makes the per-user row count bounded.
  primary key (user_id, game_id)
);

-- The read is always "my rows, newest first", so the index carries the sort. The
-- primary key cannot: it is (user_id, game_id), and game_id is not a time.
create index recently_viewed_user_recent on recently_viewed (user_id, viewed_at desc);

-- The reverse direction, for the same unindexed-foreign-key linter rule that
-- migrations 000800 and 20260909075500 exist for.
create index recently_viewed_game on recently_viewed (game_id);

alter table recently_viewed enable row level security;

create policy "own recently viewed"
  on recently_viewed for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 1. Recording a view
-- ---------------------------------------------------------------------------
-- Called by the /games/:id edge function, not by the app. The app already fetches a
-- game to render its detail screen, so the view is recorded by the act of looking --
-- no second call, nothing for the client to forget, and no way for the two sides to
-- drift apart. (`/search` results and roulette rolls are NOT views: the user has not
-- opened anything yet.)
--
-- SECURITY INVOKER, so the policy above is what enforces ownership. The function
-- never takes a user_id -- there is no argument through which one caller could write
-- another person's history.
--
-- THE TRIM IS THE POINT OF THE FUNCTION. Without it this table grows forever: a user
-- who browses 30 games a day adds 11k rows a year, all of them read by a rail that
-- shows 20. The cap keeps the per-user cost flat and bounded, and the read below can
-- then stay a plain index scan instead of a windowed query over an unbounded history.
create or replace function shelf_track_game_view(p_game_id uuid)
returns void
language plpgsql
volatile
set search_path = public
as $$
declare
  uid uuid := (select auth.uid());
begin
  -- Anon has no history and this is not an error worth failing a page render over.
  if uid is null then
    return;
  end if;

  insert into recently_viewed (user_id, game_id, viewed_at)
  values (uid, p_game_id, now())
  on conflict (user_id, game_id) do update set viewed_at = excluded.viewed_at;

  -- Keep the newest RECENTLY_VIEWED_CAP rows and drop the tail. Done here rather than
  -- in a trigger so that it runs once per view rather than once per affected row, and
  -- so the number is visible in the same place as the insert that makes it necessary.
  delete from recently_viewed rv
   where rv.user_id = uid
     and rv.game_id not in (
       select game_id
         from recently_viewed
        where user_id = uid
        order by viewed_at desc, game_id
        limit 50
     );
end;
$$;

comment on function shelf_track_game_view(uuid) is
  'Records that the caller opened a game, keeping the 50 most recent. Called by /games/:id; not part of the app-facing contract.';

-- ---------------------------------------------------------------------------
-- 2. Reading it back
-- ---------------------------------------------------------------------------
-- Returns the same twelve columns as shelf_popular_games plus `viewed_at`, so the
-- app renders these through the CatalogGame component it already has. `score` is
-- NULL for the same reason it is NULL there: it is search relevance, and nothing was
-- searched. The rail's order is recency and nothing else.
--
-- The edge function caps max_results at 100 and the table caps the user at 50, so
-- this cannot approach the 1,000-row ceiling where PostgREST silently truncates a
-- `returns setof`/`returns table` result -- the trap that nearly shipped a 56%
-- complete Steam import on 14 Sep. Worth knowing if the cap above ever rises.
create or replace function shelf_recently_viewed(
  max_results int default 20,
  p_offset    int default 0
)
returns table (
  id                 uuid,
  title              text,
  slug               text,
  release_date       date,
  genres             text[],
  cover_url          text,
  critic_score       smallint,
  ttb_normally_hours numeric(5,1),
  ttb_count          int,
  session_fit        text,
  platforms          jsonb,
  score              real,
  viewed_at          timestamptz
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
         rv.viewed_at
    from recently_viewed rv
    join games g on g.id = rv.game_id
   -- SECURITY INVOKER, so RLS already scopes this to the caller. The predicate is
   -- here anyway because it is what lets the planner use recently_viewed_user_recent
   -- for the sort; leaving it to the policy alone works but scans more.
   where rv.user_id = (select auth.uid())
   order by rv.viewed_at desc, g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

comment on function shelf_recently_viewed(int, int) is
  'The caller''s recently viewed games, newest first, in the CatalogGame row shape plus viewed_at.';

-- ---------------------------------------------------------------------------
-- 3. Grants
-- ---------------------------------------------------------------------------
-- Both grants have to go for anon to actually lose EXECUTE: Supabase's default
-- privileges add an EXPLICIT anon grant on every function created in `public`, and
-- Postgres adds the implicit PUBLIC one. Revoking PUBLIC alone slides straight past
-- the first -- that is the whole subject of migration 20260905000700.
--
-- Neither function leaks anything to anon regardless (both are SECURITY INVOKER, so
-- an anon caller meets RLS and sees no rows, and the writer returns early on a null
-- auth.uid()), but the catalog should say what we mean.
revoke all on function shelf_track_game_view(uuid)  from anon, public;
revoke all on function shelf_recently_viewed(int, int) from anon, public;

grant execute on function shelf_track_game_view(uuid)     to authenticated;
grant execute on function shelf_recently_viewed(int, int) to authenticated;
