-- Rank search results on trigram similarity blended with IGDB popularity.
--
-- THE BUG (STATUS section 4b). Similarity favours SHORT titles, so a three-word
-- shovelware title beats a famous game whose name is longer than the query.
-- Measured against the seeded catalog before this change:
--
--   cyberpunk ->  Cyberpunk SFX   0.714  0 ratings
--                 Cyberpunk Sex   0.714  0 ratings
--                 Cyberpunk 2077  0.667  1,647 ratings   <- wanted, ranked 3rd
--
-- THE RULE. A popularity bonus is added to the ordering key only:
--
--   similarity + 0.15 * ln(1 + total_rating_count) / ln(1 + 10000)
--
-- Log-scaled because rating counts are wildly skewed -- 73,169 rows sit at 0 and
-- the maximum is 5,952 -- so a linear term would let one blockbuster outrank an
-- exact title match. The 10000 reference is a FIXED constant, deliberately not
-- `max(total_rating_count)`: a data-dependent divisor would silently re-tune the
-- whole ranking every time IGDB's counts grow.
--
-- 0.15 is the entire budget popularity gets. An exact title match scores 1.0, so a
-- more popular rival needs >= 0.85 similarity to displace it. Verified against real
-- rows: searching the exact titles of eight 0-rating obscure games still returns
-- each of them first.
--
-- WHAT THIS DOES NOT FIX, so nobody re-opens 4b expecting it to. Two of the three
-- known failures are not popularity problems and this change leaves both untouched:
--
--   dragonsdogma2 -> Dragon's Dogma (0.588, 113 ratings) still beats Dragon's Dogma
--     II (0.526, 89 ratings). The wanted row is ALSO the less-rated one, so no
--     popularity rule can fix it. The needle normalizes to `dragonsdogma2` with no
--     spaces and cannot match `dragons dogma 2`. That is tokenization.
--   zelda botw -> Breath of the Wild scores 0.445, below A Link to the Past at
--     0.452, because neither the full title nor the `botw` alt title is similar to
--     the mixed needle. `botw` alone ranks it first. That is a multi-token query
--     problem.
--
-- `score` IS STILL RAW SIMILARITY, not the blended value, and that is load-bearing.
-- supabase/functions/search/index.ts compares `data[0].score` to
-- LIVE_LOOKUP_THRESHOLD (0.55) to decide whether to make a live IGDB call, and the
-- spec has the app bucket on the same number (>= 0.55 confident, 0.30-0.55 a list
-- of options). Returning the blend would quietly raise every popular game over
-- those thresholds and suppress live lookups that should happen.
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
  with hits as (
    select g.id, similarity(g.match_title, needle) as score
      from games g
     where g.match_title % needle
    union all
    select a.game_id, similarity(a.match_title, needle) * 0.98
      from game_alt_titles a
     where a.match_title % needle
  ),
  best as (
    select h.id, max(h.score) as score from hits h group by h.id
  )
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         b.score::real
    from best b
    join games g on g.id = b.id
   order by b.score
              + 0.15 * ln(1 + coalesce(g.total_rating_count, 0)) / ln(1 + 10000) desc,
            g.critic_score desc nulls last
   limit greatest(max_results, 1);
end;
$$;

-- Recreating the function resets its ACL to Supabase's default privileges, which
-- grant EXECUTE to anon. Migration 000700 explains why that is not a PUBLIC grant
-- and has to be revoked explicitly; re-apply it here or this change silently hands
-- search back to anon.
revoke all on function shelf_search_games(text, int) from public, anon;
grant execute on function shelf_search_games(text, int) to authenticated;
