-- "Popular with friends": what the people you follow are actually playing.
--
-- THE PRIVACY DECISION, taken with the user 9 Sep 2026. Migration 20260908213000 drew
-- a line -- profiles, follows, posts, likes and comments public to any signed-in
-- account; `library_entries` and `share_intake` strictly owner-only -- and this is the
-- first feature to want the other side of it. Three shapes were weighed:
--
--   posts only         rank games attached to posts by people you follow. Costs
--                      nothing in privacy terms, and stays empty until someone builds
--                      a post composer with game attachment, which nobody has
--                      scheduled -- the app's feed is still a three-item constant.
--   libraries, flat    following someone means their shelf counts. Strongest feature,
--                      but it moves the line and makes the STATUS table untrue.
--   libraries, opt-in  CHOSEN. `profiles.share_activity`: the owner publishes their
--                      activity deliberately, which is the same reasoning that made
--                      posts public in the first place.
--
-- So the line does NOT move. `library_entries` is still owner-only under RLS, not one
-- policy on it changed, and a follower reading another account's rows still gets zero
-- -- section 9 of `verify:social` goes on asserting exactly that. What is public is a
-- DERIVED AGGREGATE over people who switched it on, reachable only through this one
-- function.
--
-- WHY THIS FUNCTION IS SAFE, and the property to preserve if it is ever edited: it
-- TAKES NO USER ID. The viewer is `auth.uid()`, read inside. There is no target to
-- point it at, so it can only ever answer about people the caller already chose to
-- follow. Contrast `shelf_blocked_between`, which shipped in `public` taking two
-- arbitrary uuids and was therefore a block-list oracle (20260908214500). That is the
-- whole difference between a SECURITY DEFINER function that is safe in `public` and
-- one that is not. **Do not add a user-id argument to this.**
--
-- THE RESIDUAL LEAK, written down rather than hidden. An aggregate over a set the
-- viewer controls is not anonymous. Follow one person and every count is 1, so the
-- list is precisely their shelf. Follow five, snapshot, follow a sixth, snapshot
-- again, and the difference is the sixth person's shelf. The owner floor below raises
-- the cost of both and closes neither; the only real fix is noise, and noise in a
-- twenty-row list reads as a bug. This is the accepted residual, and it is what the
-- opt-in toggle exists to make consensual.

-- Default TRUE, deliberately. Default-off would leave the feature permanently empty
-- and indistinguishable from broken, which is how privacy toggles end up removed. The
-- statuses counted below are the two that mean "I play this", not "I want this", so
-- what is published is the mildest useful version of the claim.
--
-- Note this column is readable by any signed-in account, because the profiles SELECT
-- policy is `using (true)`. That reveals only whether someone opted out, which is not
-- the thing the toggle protects.
alter table profiles
  add column share_activity boolean not null default true;

comment on column profiles.share_activity is
  'Opt-in: count my playing/beaten library entries in other people''s "popular with friends". Never exposes which games, only aggregate counts, and only to people who follow me.';

create or replace function shelf_popular_with_friends(
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
  friend_count       bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with viewer as (
    select (select auth.uid()) as uid
  ),
  -- Who counts: people the viewer follows, who opted in, who are not blocked in
  -- either direction. The block check is inlined rather than calling
  -- private.shelf_blocked_between per row -- this function is already DEFINER and so
  -- already reads every block row, and inlining lets the planner use
  -- user_blocks' primary key instead of a function call per followee. Nothing about
  -- blocks reaches the result either way; they only remove rows.
  --
  -- The self-exclusion is redundant against the no_self_follow constraint and kept
  -- anyway: the whole point is what OTHER people play, and a silent change to that
  -- constraint should not quietly fold the viewer's own shelf into the counts.
  friends as (
    select f.followee_id as uid
      from follows f
      cross join viewer v
     where f.follower_id = v.uid
       and f.followee_id <> v.uid
       and exists (select 1 from profiles pr
                    where pr.user_id = f.followee_id
                      and pr.share_activity)
       and not exists (select 1 from user_blocks b
                        where (b.blocker_id = v.uid and b.blocked_id = f.followee_id)
                           or (b.blocker_id = f.followee_id and b.blocked_id = v.uid))
  ),
  -- 'playing' and 'beaten' only. 'dropped' is a negative signal and would be actively
  -- misleading in a list headed "popular"; 'backlog' means "intend to", which is a
  -- wishlist in all but name and a much weaker claim than the feature makes. Change
  -- the IN list if that call turns out wrong -- it is the only thing that decides it.
  --
  -- The owner floor is a LITERAL, not a parameter, and must stay one: a caller who
  -- could pass 1 would have a function that reads a single followee's shelf back
  -- verbatim, which is the exact attack the floor exists to price up.
  counted as (
    select le.game_id, count(distinct le.user_id) as friend_count
      from library_entries le
      join friends fr on fr.uid = le.user_id
     where le.status in ('playing', 'beaten')
     group by le.game_id
    having count(distinct le.user_id) >= 3
  )
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         -- NULL for the same reason shelf_popular_games returns NULL here: `score` is
         -- a similarity score everywhere else, and putting a different quantity in it
         -- is a trap for the next caller. The count has its own column.
         null::real,
         c.friend_count
    from counted c
    join games g on g.id = c.game_id
    -- The trailing id is not decoration. Ties on friend_count will be the common case
    -- at small follower counts, and without a unique final key offset pagination drops
    -- and repeats rows between pages -- the lesson from shelf_popular_games.
   order by c.friend_count desc, coalesce(g.total_rating_count, 0) desc, g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

-- Migration 000700's rule. This one is SECURITY DEFINER, so an `anon` execute grant
-- would hand an unauthenticated caller the function outright -- it would return empty
-- (auth.uid() is null, so `friends` is empty), but the posture is not worth relying on
-- a NULL comparison for.
revoke all on function shelf_popular_with_friends(int, int) from public, anon;
grant execute on function shelf_popular_with_friends(int, int) to authenticated;
