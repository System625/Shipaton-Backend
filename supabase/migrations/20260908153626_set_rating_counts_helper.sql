-- A set-based writer for the popularity backfill.
--
-- PostgREST cannot bulk-update by key: `.upsert()` compiles to INSERT .. ON
-- CONFLICT, whose INSERT arm needs every NOT NULL column, so updating one field on
-- 89,117 rows through it would mean re-sending `title` and `match_title` for each.
-- The alternative is 89,117 single-row PATCHes. Both are worse than one statement.
--
-- Nothing in the repo reads DATABASE_URL (STATUS section 6), and adding a Postgres
-- driver just to run one UPDATE is a heavier change than this function.
--
-- `is distinct from` makes a re-run cheap and idempotent: rows already carrying the
-- value are not rewritten, so the backfill can be interrupted and restarted without
-- redoing work. That matters here -- the seed's "re-run both passes from zero,
-- never resume" hazard is exactly what this backfill exists to avoid.
create or replace function shelf_set_rating_counts(p jsonb)
returns int
language sql
volatile
set search_path = public
as $$
  with input as (
    select (e->>'igdb_id')::int as igdb_id,
           (e->>'count')::int   as cnt
      from jsonb_array_elements(p) e
  ),
  upd as (
    update games g
       set total_rating_count = i.cnt
      from input i
     where g.igdb_id = i.igdb_id
       and g.total_rating_count is distinct from i.cnt
    returning 1
  )
  select count(*)::int from upd;
$$;

-- Service role only. This writes catalog rows, so no client-facing role gets it.
-- Both grants have to go or the caller keeps EXECUTE -- see migration 000700 for
-- why revoking PUBLIC alone is not enough on this project.
revoke all on function shelf_set_rating_counts(jsonb) from public, anon, authenticated;
