-- Adds games.release_precision: how precisely IGDB actually knows a release date.
--
-- research/events-screen.md measured that 80.4% of the catalog's 3,748 upcoming
-- release dates are placeholders -- IGDB encodes "sometime in 2027" as a real
-- `date` (31 Dec, 30 Sep, ...) with nothing on the row itself marking it as vague.
-- `release_tbd` does not catch this: it is `!first_release_date` on the mapper
-- (mapping.ts), so it is only ever true when IGDB gives no date at all (2 rows in
-- the whole catalog) -- correct for what it checks, just a narrower thing than
-- "vague date". This column is the actual fix.
--
-- CORRECTION to research/events-screen.md, verified live against IGDB 17 Sep 2026:
-- the doc names the source field `release_dates.category` and says the seed
-- "already fetches and discards" it. Neither is true. IGDB's current API has no
-- `category` field on release_dates -- that name is stale (older docs / memory);
-- the live field is `date_format`, and it was not being requested anywhere in this
-- repo before today (see igdb.ts GAME_FIELDS and mapping.ts releasePrecision()).
--
-- date_format values, confirmed against live IGDB (not assumed from docs):
--   0 day (YYYYMMDD)  1 month (YYYYMM)  2 year (YYYY)
--   3-6 a quarter (Q1-Q4)              7 TBD (no date at all)
-- A game can carry several release_dates rows, one per platform; releasePrecision()
-- picks the one whose `date` matches `first_release_date`.

alter table games
  add column release_precision text
    check (release_precision in ('day','month','quarter','year'));

comment on column games.release_precision is
  'Precision of release_date, derived from IGDB release_dates.date_format on the row matching first_release_date. NULL means release_tbd (no date at all) or an unmatched row -- either way, do not present release_date as day-accurate without checking this first.';

-- ---------------------------------------------------------------------------
-- Backfill writer, same shape and same reason as shelf_set_rating_counts
-- (20260908153626): PostgREST .upsert() needs every NOT NULL column to bulk-write
-- by key, and 91,806 single-row PATCHes is worse than one statement. `is distinct
-- from` keeps a re-run cheap and idempotent -- see scripts/backfill-release-
-- precision.ts, which pages by igdb_id the same way backfill-rating-counts.ts does.
-- ---------------------------------------------------------------------------
create or replace function shelf_set_release_precision(p jsonb)
returns int
language sql
volatile
set search_path = public
as $$
  with input as (
    select (e->>'igdb_id')::int as igdb_id,
           (e->>'precision')   as prec
      from jsonb_array_elements(p) e
  ),
  upd as (
    update games g
       set release_precision = i.prec
      from input i
     where g.igdb_id = i.igdb_id
       and g.release_precision is distinct from i.prec
    returning 1
  )
  select count(*)::int from upd;
$$;

-- Service role only, same as shelf_set_rating_counts -- this writes catalog rows.
revoke all on function shelf_set_release_precision(jsonb) from public, anon, authenticated;
