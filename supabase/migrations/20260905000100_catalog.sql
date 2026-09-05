-- Shelf catalog: platforms, games, game_platforms, search_cache.
-- Source: docs/spec.md section 3.
--
-- pg_trgm installs into the `extensions` schema on Supabase, not `public`.
-- If similarity() or the % operator ever reports "function does not exist",
-- that is the search_path, not a missing extension (spec section 10).
create extension if not exists pg_trgm with schema extensions;

-- Seeded once from IGDB /platforms, then effectively static.
create table platforms (
  id     int  primary key,          -- IGDB's platform id, stable enough to use directly
  slug   text not null unique,
  name   text not null,
  family text                       -- 'playstation' | 'xbox' | 'nintendo' | 'pc' | 'mobile'
);

create table games (
  id                   uuid primary key default gen_random_uuid(),
  igdb_id              int unique,          -- reference only. Nothing outside the sync layer reads this.
  rawg_id              int unique,          -- reserved for the fallback in spec section 11
  slug                 text,
  title                text not null,
  match_title          text not null,       -- normalized, see spec section 5
  release_date         date,
  release_tbd          boolean not null default false,
  cover_url            text,
  genres               text[] not null default '{}',
  critic_score         smallint,            -- IGDB aggregated_rating, 0-100. NOT Metacritic.
  igdb_game_type       smallint,            -- 0 = main game
  ttb_hastily_hours    numeric(5,1),
  ttb_normally_hours   numeric(5,1),        -- the default
  ttb_completely_hours numeric(5,1),
  ttb_count            int,                 -- submissions behind the estimate; low count = low confidence
  session_fit          text check (session_fit in ('high','medium','low')),
  source               text not null default 'igdb' check (source in ('igdb','user')),
  synced_at            timestamptz,
  created_at           timestamptz not null default now()
);

create index games_match_title_trgm on games using gin (match_title extensions.gin_trgm_ops);
create index games_ttb              on games (ttb_normally_hours);
create index games_session_fit      on games (session_fit);

create table game_platforms (
  game_id     uuid not null references games(id) on delete cascade,
  platform_id int  not null references platforms(id),
  primary key (game_id, platform_id)
);

create index game_platforms_platform on game_platforms (platform_id);

-- Saves round trips on repeat searches. Less critical under IGDB than it was
-- under RAWG, but still worth having.
create table search_cache (
  query_norm text primary key,
  game_ids   uuid[] not null,
  fetched_at timestamptz not null default now()
);
