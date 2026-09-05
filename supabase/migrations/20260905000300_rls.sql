-- Row level security.
-- Catalog: readable by any signed-in user, writable only by the service role
-- (the seed script and the sync layer). No policy = no access for anon/authenticated,
-- and the service role bypasses RLS entirely, so writes need no policy at all.
-- User data: strictly owner-only.

alter table platforms      enable row level security;
alter table games          enable row level security;
alter table game_platforms enable row level security;
alter table search_cache   enable row level security;

create policy "catalog readable by authenticated"
  on platforms for select to authenticated using (true);
create policy "catalog readable by authenticated"
  on games for select to authenticated using (true);
create policy "catalog readable by authenticated"
  on game_platforms for select to authenticated using (true);

alter table library_entries enable row level security;
alter table share_intake    enable row level security;

create policy "own library entries"
  on library_entries for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "own share intake"
  on share_intake for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
