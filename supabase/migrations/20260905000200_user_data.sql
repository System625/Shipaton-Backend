-- Shelf user data: library_entries and share_intake.
-- Source: docs/spec.md section 3.

create table library_entries (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  game_id      uuid not null references games(id),
  status       text not null check (status in ('playing','backlog','beaten','dropped')),
  rating       smallint check (rating between 1 and 10),
  notes        text not null default '',
  hours_played numeric(5,1),
  platform_id  int references platforms(id),  -- what THEY play it on, not availability
  source_url   text,                          -- the TikTok / YouTube link. The differentiator.
  source_kind  text check (source_kind in ('tiktok','youtube','search','manual')),
  added_at     timestamptz not null default now(),
  finished_at  timestamptz,
  unique (user_id, game_id)
);

create index library_entries_user_status on library_entries (user_id, status);

-- A row is written the instant a share arrives, before any matching. If resolution
-- fails the link is still saved. Nothing a user shares is ever silently dropped.
create table share_intake (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  raw_url            text not null,
  provider           text check (provider in ('tiktok','youtube','other')),
  extracted_text     text,
  candidate_game_ids uuid[] not null default '{}',
  status             text not null default 'pending'
                       check (status in ('pending','matched','unmatched','dismissed')),
  matched_game_id    uuid references games(id),
  created_at         timestamptz not null default now()
);

create index share_intake_user_status on share_intake (user_id, status);
