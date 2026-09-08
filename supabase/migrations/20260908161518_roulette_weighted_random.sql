-- The roulette was not random, and p_session_hours did nothing. Both were the same
-- mistake: the ranking was three INDEPENDENT sort keys rather than one score.
--
--   order by playing_flag * (2.0 or 0.5) desc,
--            fit_score    * (1.5 or 0.3) desc,
--            random()
--
-- Multiplying a sort key by a positive constant cannot change its ordering, so the
-- two weight sets rank identically and p_session_hours was inert — verified by
-- ranking a fixture under both and diffing: every position identical. And because
-- the first two keys almost always have a unique maximum, random() was only ever a
-- tiebreak that never fired: 25 rolls against a 9-game backlog returned the same
-- game 25 times (scripts/verify-roulette.ts, 8 Sep 2026).
--
-- The fix is weighted random selection (Efraimidis-Spirakis): give each row a key of
-- random() ^ (1/weight) and take the largest. For a single draw the probability of
-- picking a row is exactly proportional to its weight, so:
--
--   * every row with weight > 0 stays reachable — nothing is ever excluded, which is
--     the property spec section 7 is built around;
--   * p_session_hours now genuinely reweights, continuously rather than in two steps.
--
-- Weight: 1 + urgency * (2 * resuming + 1 * session_fit), where urgency runs from 1
-- at a half-hour evening to 0 at four hours and beyond. So a short window tilts hard
-- toward resuming a game already in progress and toward high session_fit, and a long
-- window flattens to uniform — "surprise me", which is what a free evening wants.
-- A plain backlog entry weighs 1; a high-fit game already being played weighs 5 on
-- the shortest evening, i.e. five times likelier, never certain.
create or replace function shelf_roulette(
  p_user_id       uuid,
  p_platform_id   int,
  p_size_bucket   text default null,
  p_session_hours numeric default 2
)
returns setof shelf_catalog_row
language sql
stable
set search_path = public, extensions
as $$
  with urgency as (
    select greatest(0.0, least(1.0, (4.0 - p_session_hours) / 3.5))::double precision as u
  )
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp2 join platforms p on p.id = gp2.platform_id
             where gp2.game_id = g.id),
           '[]'::jsonb),
         null::real
    from library_entries le
    join games g           on g.id = le.game_id
    join game_platforms gp on gp.game_id = g.id
   cross join urgency
   -- RLS on library_entries already scopes this to the caller. The auth.uid()
   -- check makes it a hole-free function in its own right rather than one that
   -- depends on a policy staying in place.
   where le.user_id = p_user_id
     and p_user_id = (select auth.uid())
     and le.status in ('backlog','playing')
     and gp.platform_id = p_platform_id
     -- size is the ONLY filter. hours must never appear in a where clause.
     and (p_size_bucket is null or
          case p_size_bucket
            when 'quick'  then coalesce(g.ttb_normally_hours, 15) <  10
            when 'medium' then coalesce(g.ttb_normally_hours, 15) between 10 and 30
            when 'epic'   then coalesce(g.ttb_normally_hours, 15) >  30
            else true
          end)
   order by
     power(
       random(),
       1.0 / (
         1.0
         + urgency.u * 2.0 * (case when le.status = 'playing' then 1 else 0 end)
         + urgency.u * 1.0 * (case g.session_fit when 'high' then 2 when 'medium' then 1 else 0 end)
       )
     ) desc
   limit 1;
$$;

-- `create or replace` restores the default PUBLIC execute grant, and `authenticated`
-- inherits from PUBLIC — so without these two lines anon silently regains execute on
-- a function that reads user data. Re-issue them after every replace.
revoke all on function shelf_roulette(uuid, int, text, numeric) from public;
grant execute on function shelf_roulette(uuid, int, text, numeric) to authenticated;
