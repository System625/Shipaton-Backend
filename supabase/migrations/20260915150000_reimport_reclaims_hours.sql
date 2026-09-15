-- Fixes defect 8d: a re-import after a disconnect could never refresh an edited
-- row's hours again, because disconnect sets source_kind='manual' and
-- shelf_import_library's coalesce kept it that way forever.
-- Source: docs/research/account-linking.md section 8d, option 2 ("let a re-import
-- re-adopt a 'manual' row"), taken with the condition option 2 was written under:
-- a hand-added row's own hours must survive an import touching it, which the old
-- schema could not express because 'source_kind = p_source' was the only signal
-- shelf_import_library had for "do these hours belong to this import."
--
-- THE ACTUAL DISTINCTION IS OWNERSHIP OF THE NUMBER, NOT OF THE ROW. A row can be
-- 'steam'-sourced today and still hold an hours figure nobody but the import ever
-- wrote (defect 8d's case, once disconnected), or it can be 'manual' and still hold
-- an hours figure the import wrote before the user touched anything else about it
-- (also defect 8d's case — g2 in verify-account-linking.ts). What decides whether a
-- re-import may overwrite hours_played is only ever "did a human set this number,"
-- which source_kind cannot answer alone.

alter table library_entries
  add column hours_played_is_own boolean not null default true;

-- Backfill. Rows on a currently-connected platform have hours the import is still
-- actively refreshing — those are not the user's own by any measure and must start
-- out reclaimable. Everything else (including 'manual' rows left behind by a past
-- disconnect, which are indistinguishable after the fact from a row someone really
-- typed) defaults to the safer state: own, so an old row never starts auto-refreshing
-- hours nobody asked it to.
update library_entries
set hours_played_is_own = false
where source_kind in ('steam', 'xbox', 'psn');

comment on column library_entries.hours_played_is_own is
  'false = the last write to hours_played came from an import (shelf_import_library
   may overwrite it on the next one); true = a human set it, directly or via a
   hand-added row, and no import may touch it again. Flipped to true by the
   library_entries_hours_ownership trigger the moment anything other than
   shelf_import_library changes hours_played; flipped to false only by
   shelf_import_library itself, which is the one writer allowed to claim a number
   back.';

-- The trigger is what makes the flag trustworthy against a write path
-- shelf_import_library does not control: library_entries has an "own rows, all
-- operations" RLS policy (20260905000300_rls.sql), so the app can PATCH
-- hours_played directly today, RPC or no RPC. Without this, a user typing their own
-- hours would look identical, to shelf_import_library, to an import's own stale
-- figure — the exact ambiguity that made defect 8d unsafe to fix with a coalesce
-- alone.
create or replace function library_entries_hours_ownership()
returns trigger
language plpgsql
as $$
begin
  -- shelf_import_library sets this GUC (transaction-local) before it writes, and
  -- sets hours_played_is_own itself in that same statement. Every other writer —
  -- a client PATCH included — leaves it unset, which is what marks the write as
  -- human.
  if current_setting('shelf.importing', true) = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.hours_played_is_own := true;
  elsif new.hours_played is distinct from old.hours_played then
    new.hours_played_is_own := true;
  end if;

  return new;
end;
$$;

create trigger library_entries_hours_ownership
  before insert or update on library_entries
  for each row execute function library_entries_hours_ownership();

-- shelf_import_library, rewritten: 'not hours_played_is_own' replaces
-- 'source_kind = p_source' as the gate on every column an import may reclaim
-- (hours_played, source_kind, imported_uid together — they must move as one, or
-- the provenance-contradiction half of defect 8d reappears in a new shape).
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
  if p_source not in ('steam','xbox','psn') then
    raise exception 'unknown import source: %', p_source;
  end if;

  -- Local to this statement's transaction (third arg true = is_local). Tells the
  -- ownership trigger above that hours_played_is_own is this function's call to
  -- make, not the trigger's.
  perform set_config('shelf.importing', 'on', true);

  with items as (
    select
      (i->>'game_id')::uuid as game_id,
      i->>'uid'             as uid,
      (i->>'hours')::numeric as hours
    from jsonb_array_elements(p_items) as i
  ),
  deduped as (
    select
      game_id,
      min(uid) as uid,
      least(coalesce(sum(hours), 0), 9999.9) as hours
    from items
    group by game_id
  ),
  upserted as (
    insert into library_entries
      (user_id, game_id, status, hours_played, source_kind, imported_uid, hours_played_is_own)
    select v_user, d.game_id, 'backlog', d.hours, p_source, d.uid, false
    from deduped d
    on conflict (user_id, game_id) do update set
      -- status, rating, notes and finished_at are ABSENT from this list on purpose.
      -- See rule 2 in the header comment above this migration's predecessor. Adding
      -- one here silently rewrites people's libraries.
      hours_played = case
        when not library_entries.hours_played_is_own then excluded.hours_played
        else coalesce(library_entries.hours_played, excluded.hours_played)
      end,
      source_kind = case
        when not library_entries.hours_played_is_own then excluded.source_kind
        else coalesce(library_entries.source_kind, excluded.source_kind)
      end,
      imported_uid = case
        when not library_entries.hours_played_is_own then excluded.imported_uid
        else coalesce(library_entries.imported_uid, excluded.imported_uid)
      end
      -- hours_played_is_own is NOT in this list. Left alone, an UPDATE keeps a
      -- row's existing value, which is exactly right: a row that was already
      -- reclaimable (false) stays reclaimable, and one a human owns (true) stays
      -- owned. The trigger above is what ever flips it back to true; this
      -- function is the only thing allowed to flip it to false, and it does that
      -- only on a fresh insert.
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
