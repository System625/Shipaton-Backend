-- The write half of an import: defect 8b, solved in SQL rather than in TypeScript.
-- Source: docs/research/account-linking.md section 8b.
--
-- WHY THIS IS NOT A LOOP IN THE EDGE FUNCTION. A Steam library is a few hundred
-- rows and the naive version is three round trips plus one PATCH per already-owned
-- game, inside a function with a 2s CPU budget. As one statement it is a single
-- call, and it is atomic — a half-written import is the one outcome worse than a
-- failed one, because the user cannot tell it happened.
--
-- THE TWO RULES THIS ENCODES, both from section 8b:
--
--   1. DEDUPE BEFORE WRITING. Once the parent hop collapses editions onto their
--      base game, two owned appids routinely land on one catalog game — Skyrim and
--      Skyrim Special Edition are the canonical pair. A plain insert of 400 rows
--      dies on the first collision and takes the batch with it.
--   2. FILL IN BLANKS, DO NOT RELITIGATE THE SHELF. An import must never overwrite
--      a status, rating or note the user set by hand. Someone who beat a game and
--      wrote about it must not find it back in their backlog because they
--      connected Steam.
--
-- The one exception is hours on rows the import itself created: those are ours, so
-- a re-import refreshes them. Anything the user has made their own keeps its value.

create or replace function shelf_import_library(p_source text, p_items jsonb)
returns table (inserted int, updated int)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_inserted int;
  v_updated int;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;
  -- Same guard as shelf_disconnect_platform: the argument becomes source_kind, and
  -- 'manual' here would let an import masquerade as hand-entered rows.
  if p_source not in ('steam','xbox','psn') then
    raise exception 'unknown import source: %', p_source;
  end if;

  with items as (
    select
      (i->>'game_id')::uuid as game_id,
      i->>'uid'             as uid,
      (i->>'hours')::numeric as hours
    from jsonb_array_elements(p_items) as i
  ),
  -- Rule 1. Playtime is SUMMED across the ids that collapsed together, because
  -- hours in Skyrim and hours in Skyrim Special Edition are both hours in Skyrim.
  -- The clamp is re-applied after the sum for the same reason it exists at all:
  -- hours_played is numeric(5,1) and two large editions can cross 9,999.9 even
  -- when neither did alone.
  deduped as (
    select
      game_id,
      min(uid) as uid,
      -- coalesce BEFORE least, not after. Postgres's least() ignores NULLs and
      -- returns the smallest non-null argument, so `least(null, 9999.9)` is 9999.9,
      -- not null — an item that arrived without an `hours` key would be recorded as
      -- ten thousand hours played. The caller always sends a number today; this is
      -- so it stays correct when something else calls it.
      least(coalesce(sum(hours), 0), 9999.9) as hours
    from items
    group by game_id
  ),
  upserted as (
    insert into library_entries (user_id, game_id, status, hours_played, source_kind, imported_uid)
    select v_user, d.game_id, 'backlog', d.hours, p_source, d.uid
    from deduped d
    on conflict (user_id, game_id) do update set
      -- status, rating, notes and finished_at are ABSENT from this list on purpose.
      -- See rule 2. Adding one here silently rewrites people's libraries.
      hours_played = case
        when library_entries.source_kind = p_source then excluded.hours_played
        else coalesce(library_entries.hours_played, excluded.hours_played)
      end,
      source_kind  = coalesce(library_entries.source_kind, excluded.source_kind),
      imported_uid = coalesce(library_entries.imported_uid, excluded.imported_uid)
    returning (xmax = 0) as was_insert
  )
  select
    count(*) filter (where was_insert)::int,
    count(*) filter (where not was_insert)::int
  into v_inserted, v_updated
  from upserted;

  return query select v_inserted, v_updated;
end;
$$;

revoke all on function shelf_import_library(text, jsonb) from public, anon;
grant execute on function shelf_import_library(text, jsonb) to authenticated;
