-- Read paths behind /search and /roulette. Source: docs/spec.md sections 5 and 7.
--
-- Both return the games columns plus platforms pre-joined as jsonb, so an edge
-- function makes one round trip. Deriving `abbreviation` and `colorKey` is left to
-- TypeScript (supabase/functions/_shared/catalog-game.ts) so every endpoint shapes
-- CatalogGame identically.
--
-- Both are SECURITY INVOKER (the default), so RLS applies to everything they read.

create type shelf_catalog_row as (
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
  score              real
);

-- plpgsql rather than sql so the normalized needle is a local variable. Passing a
-- scalar subquery to the `%` operator can stop the planner using the trigram GIN
-- index; a variable cannot.
--
-- `%` uses pg_trgm.similarity_threshold, which defaults to 0.3 — the same floor the
-- spec calls "plausible". Callers bucket on the returned score: >= 0.55 is a
-- confident best guess, 0.30-0.55 is a list of options.
create or replace function shelf_search_games(q text, max_results int default 5)
returns setof shelf_catalog_row
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  needle text := shelf_match_title(q);
begin
  if needle = '' then
    return;
  end if;

  return query
    select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
           g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
           coalesce(
             (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                               order by p.name)
                from game_platforms gp join platforms p on p.id = gp.platform_id
               where gp.game_id = g.id),
             '[]'::jsonb),
           similarity(g.match_title, needle) as score
      from games g
     where g.match_title % needle
     order by score desc, g.critic_score desc nulls last
     limit greatest(max_results, 1);
end;
$$;

-- Always returns something as long as the backlog is non-empty on that platform.
-- A roulette that comes back empty is a broken roulette (spec section 7).
--
-- p_size_bucket:   'quick' (<10h) | 'medium' (10-30h) | 'epic' (>30h) | null for any
-- p_session_hours: how long the user has free tonight. It does NOT filter, it only
--                  reweights. Time to beat is total completion time and is a
--                  different quantity on a different scale — that mismatch is the
--                  whole reason the input is split in two.
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
   -- RLS on library_entries already scopes this to the caller. The auth.uid()
   -- check makes it a hole-free function in its own right rather than one that
   -- depends on a policy staying in place.
   where le.user_id = p_user_id
     and p_user_id = (select auth.uid())
     and le.status in ('backlog','playing')
     and gp.platform_id = p_platform_id
     and (p_size_bucket is null or
          case p_size_bucket
            when 'quick'  then coalesce(g.ttb_normally_hours, 15) <  10
            when 'medium' then coalesce(g.ttb_normally_hours, 15) between 10 and 30
            when 'epic'   then coalesce(g.ttb_normally_hours, 15) >  30
            else true
          end)
   order by
     -- resuming beats starting, and the shorter the evening the more that matters
     (case when le.status = 'playing' then 1 else 0 end)
       * (case when p_session_hours < 2 then 2.0 else 0.5 end) desc,
     -- high session_fit ranks higher in a short window; long low-fit games rank
     -- lower but are never excluded
     (case g.session_fit when 'high' then 2 when 'medium' then 1 else 0 end)
       * (case when p_session_hours < 2 then 1.5 else 0.3 end) desc,
     random()
   limit 1;
$$;

-- `revoke from public` would also strip `authenticated`, which inherits the PUBLIC
-- grant, so re-grant explicitly. anon gets nothing: every endpoint is authenticated.
revoke all on function shelf_search_games(text, int) from public;
revoke all on function shelf_roulette(uuid, int, text, numeric) from public;
grant execute on function shelf_search_games(text, int) to authenticated;
grant execute on function shelf_roulette(uuid, int, text, numeric) to authenticated;
