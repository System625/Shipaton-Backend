-- Android account linking (build order item 3, docs/research/account-linking.md
-- §7 and §10). Unlike Steam and Xbox this is not an OAuth handshake at all: the
-- app detects installed package names on-device (the `<queries>` manifest trick)
-- and posts them straight to android-import with the caller's own JWT. IGDB
-- source 15 stores the Play Store package name verbatim, so
-- shelf_resolve_external_ids('android', ...) already works today against
-- game_external_ids — 'android' has been in that table's source check constraint
-- since 20260914100000. Nothing there needs to change.
--
-- What DOES need to change: the write side. source_kind and the two functions
-- that gate it by an explicit allow-list were written for the three account-based
-- platforms only, so 'android' is a 409-in-disguise (a constraint violation) until
-- it is added here.
--
-- NO platform_accounts ROW. Steam and Xbox rows there represent a linked external
-- identity with a persistent external_id — that is what "connect" and "disconnect"
-- mean for them. Android has no account to connect: there is nothing to
-- authenticate, no identity to store, and re-scanning the device is just calling
-- the endpoint again. shelf_disconnect_platform('android') still works below (it
-- deletes untouched imported rows and clears provenance on edited ones, same as
-- every other source) — its `delete from platform_accounts where platform = ...`
-- clause simply matches zero rows for android, which is correct, not a gap.

alter table library_entries drop constraint library_entries_source_kind_check;
alter table library_entries add constraint library_entries_source_kind_check
  check (source_kind in ('tiktok','youtube','search','manual','steam','xbox','psn','android'));

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
  if p_source not in ('steam','xbox','psn','android') then
    raise exception 'unknown import source: %', p_source;
  end if;

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

create or replace function shelf_disconnect_platform(p_platform text)
returns table (removed_entries int)
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_removed int;
begin
  if v_user is null then
    raise exception 'not authenticated';
  end if;

  if p_platform not in ('steam','xbox','psn','android') then
    raise exception 'unknown platform: %', p_platform;
  end if;

  with gone as (
    delete from library_entries
    where user_id = v_user
      and source_kind = p_platform
      and status = 'backlog'
      and rating is null
      and notes = ''
      and finished_at is null
    returning 1
  )
  select count(*)::int into v_removed from gone;

  delete from platform_accounts
  where user_id = v_user and platform = p_platform;

  update library_entries
  set source_kind = 'manual', imported_uid = null
  where user_id = v_user and source_kind = p_platform;

  return query select v_removed;
end;
$$;

revoke all on function shelf_disconnect_platform(text) from public, anon;
grant execute on function shelf_disconnect_platform(text) to authenticated;
