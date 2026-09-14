-- Step 0 of account linking: the store-id → catalog-game map.
-- Source: docs/research/account-linking.md section 8d and section 10.
--
-- WHY A TABLE AND NOT A LIVE LOOKUP. An import hands us a few hundred store ids at
-- once. Resolving those against IGDB at request time means a few hundred
-- `external_games` round trips under IGDB's 4 req/sec throttle, on the user's
-- critical path, inside an edge function that gets 2s CPU / 150s wall clock. That
-- does not fit. Seeded here, a 400-game Steam import is one `where uid = any(...)`
-- with zero network calls.
--
-- WHAT A ROW MEANS: "if a platform hands you this id, put THIS catalog game in the
-- user's library". It is deliberately NOT a mirror of IGDB's `external_games` —
-- see `via_parent` below, which is the whole reason the table earns its keep.

create table game_external_ids (
  -- Only the sources whose identifiers actually join to something a platform API
  -- returns. Steam's appid and Android's package name are stored by IGDB verbatim
  -- (measured 12 Sep: `271590` = `271590`). 'microsoft' is the Microsoft *Store*
  -- product id (`9NDXJG3LSP32`), which does NOT equal the Xbox Live title id
  -- OpenXBL returns — it is here as the left-hand side of the DisplayCatalog bridge
  -- that has to be measured before Xbox can be built, not as something an import
  -- can use today. PlayStation is absent on purpose: IGDB carries a store *concept*
  -- id and psn-api returns an `npCommunicationId`, so PSN resolves by name and a
  -- row here would be dead weight that reads as if it worked.
  source     text not null check (source in ('steam','microsoft','android')),
  uid        text not null,
  game_id    uuid not null references games(id) on delete cascade,

  -- TRUE when the uid names an edition/remaster/bundle that our seed deliberately
  -- excludes (`game_type <> 0`), and we resolved it to its parent instead. This is
  -- the 78.1% → 87.8% difference measured in section 1: "Skyrim Special Edition"
  -- is not in the catalog and never will be, but the person who owns it owns
  -- Skyrim and must see a row.
  via_parent boolean not null default false,

  -- The IGDB game the uid literally names. Equals games.igdb_id when via_parent is
  -- false, and is the *edition's* id when it is true. Kept so a re-seed can tell a
  -- stale edge from a changed one, and so anyone debugging a wrong import can see
  -- which hop produced it. Nothing at request time reads it.
  igdb_id    int not null,

  -- EDGES, NOT A UNIQUE MAPPING. One id can legitimately reach more than one
  -- catalog game once parents are followed, and one catalog game has many ids
  -- (every edition of it). Forcing `unique (source, uid)` here would make the seed
  -- pick a winner silently; the importer picks one instead, in the open, preferring
  -- a direct edge over a parent hop. See shelf_resolve_external_ids below.
  primary key (source, uid, game_id)
);

-- The import direction: "here are 400 appids, which games are they?"
-- The primary key already serves (source, uid) prefix lookups, so this index is
-- the reverse direction only: "which store ids does this game have?", used by the
-- re-seed to find stale edges and by the disconnect path.
create index game_external_ids_game on game_external_ids (game_id);

alter table game_external_ids enable row level security;

-- Catalog data, same rule as games/platforms: readable by any signed-in user,
-- written only by the seed script through the service role. The import runs inside
-- an edge function under the *caller's* JWT, so it needs this select policy —
-- an edge function must never reach for the service role to do a user's work.
create policy "catalog readable by authenticated"
  on game_external_ids for select to authenticated using (true);


-- Resolve a batch of store ids to catalog games, one id per row, ties broken here
-- rather than in the seed.
--
-- PREFERENCE ORDER, and why: a direct edge always beats a parent hop, because a
-- direct edge means the store id names a game we actually hold. Below that, the
-- lowest igdb_id wins — arbitrary, but STABLE, which is the property that matters:
-- re-running an import must not shuffle somebody's library.
create or replace function shelf_resolve_external_ids(p_source text, p_uids text[])
returns table (uid text, game_id uuid, via_parent boolean)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select distinct on (e.uid) e.uid, e.game_id, e.via_parent
  from game_external_ids e
  where e.source = p_source
    and e.uid = any(p_uids)
  order by e.uid, e.via_parent asc, e.igdb_id asc;
$$;

revoke execute on function shelf_resolve_external_ids(text, text[]) from public, anon;
grant execute on function shelf_resolve_external_ids(text, text[]) to authenticated, service_role;
