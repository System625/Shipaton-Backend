-- Move the block check out of the schema PostgREST exposes.
--
-- THE LEAK, caught by the security advisor immediately after 20260908213500 applied:
-- shelf_blocked_between is SECURITY DEFINER (it must see blocks in BOTH directions,
-- while the RLS policy on user_blocks deliberately shows a caller only their own), and
-- everything in `public` is reachable at /rest/v1/rpc/. So any signed-in account could
-- call it with two arbitrary uuids and learn whether two other people had blocked each
-- other -- the single fact a block exists to keep private.
--
-- The three ways out, and why this one:
--
--   SECURITY INVOKER      breaks it. Under RLS the caller sees only blocks they made,
--                         so "did they block me?" always answers false.
--   revoke EXECUTE        breaks it too. An RLS policy expression is evaluated as the
--                         querying role, so `authenticated` must be able to execute it.
--   move out of `public`  works. PostgREST only exposes the schemas it is configured
--                         with, so a function in `private` is callable from inside a
--                         policy and unreachable over HTTP.
--
-- The policies depend on the function, so they have to be dropped before it can be.

drop policy "posts readable unless blocked"    on posts;
drop policy "comments readable unless blocked" on post_comments;
drop policy "own comments insert"              on post_comments;

drop function if exists shelf_blocked_between(uuid, uuid);

create schema if not exists private;

-- USAGE only, and only for the roles that evaluate policies. No CREATE: nothing else
-- should be putting objects here by accident.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.shelf_blocked_between(p_viewer uuid, p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_blocks b
     where (b.blocker_id = p_viewer and b.blocked_id = p_author)
        or (b.blocker_id = p_author and b.blocked_id = p_viewer)
  );
$$;

revoke all on function private.shelf_blocked_between(uuid, uuid) from public, anon;
grant execute on function private.shelf_blocked_between(uuid, uuid) to authenticated;

create policy "posts readable unless blocked"
  on posts for select to authenticated
  using (not private.shelf_blocked_between((select auth.uid()), author_id));

create policy "comments readable unless blocked"
  on post_comments for select to authenticated
  using (not private.shelf_blocked_between((select auth.uid()), author_id));

create policy "own comments insert"
  on post_comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (select 1 from posts p
                 where p.id = post_id
                   and not private.shelf_blocked_between((select auth.uid()), p.author_id))
  );
