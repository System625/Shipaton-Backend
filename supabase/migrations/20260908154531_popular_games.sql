-- The read path behind GET /games/popular. Source: Sola's request, 8 Sep.
--
-- SECURITY INVOKER like the other two catalog functions, so RLS applies. `games` is
-- readable by any authenticated user; nothing here touches user data.
--
-- Ordering is `total_rating_count desc, id` -- the id is not decoration. 73,169 of
-- 89,117 rows share the value 0 and thousands more share small counts, so without a
-- unique tie-break Postgres is free to return ties in a different order per call,
-- and offset pagination would then drop and repeat rows between pages.
--
-- `where total_rating_count > 0` is what keeps the tail out: the 73,169 zero-rating
-- rows are not "less popular games", they are shovelware with no signal at all, and
-- ordering them by id would put an arbitrary one on page 4. It also means the list
-- is finite -- 15,948 rows -- which is the honest size of "popular" in this catalog.
--
-- The `score` column of shelf_catalog_row is returned NULL rather than carrying the
-- rating count. CatalogGame (spec section 8) has no popularity field, toCatalogGame
-- ignores `score`, and putting a count in a column every other caller reads as a
-- similarity score would be a trap for the next person. Adding popularity to the
-- app contract is a separate decision that Sola has to be part of.
create or replace function shelf_popular_games(
  max_results int default 20,
  p_offset    int default 0
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
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         null::real
    from games g
   where g.total_rating_count > 0
   order by g.total_rating_count desc, g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

-- Same posture as shelf_search_games: authenticated only, never anon. Both the
-- explicit Supabase default-privileges grant and the implicit PUBLIC grant have to
-- go or anon keeps EXECUTE -- see migration 000700 for why one revoke is not enough.
revoke all on function shelf_popular_games(int, int) from public, anon;
grant execute on function shelf_popular_games(int, int) to authenticated;
