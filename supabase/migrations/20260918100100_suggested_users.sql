-- Onboarding step 5, "Meet players like you" -- not skippable, and blocked on this.
-- The search box and Follow button are real (shelf_search_users, followUser); what a
-- brand-new user sees before typing anything is not. Raised by Sola in task.md
-- (16 Sep), re-specified against `Prysm - Onboarding.pdf` and decided 18 Sep -- see
-- docs/research/onboarding-steps-4-5.md for the reasoning behind every choice below.
--
-- Depends on 20260918100000: the platform term reads profiles.platforms.

create or replace function shelf_suggested_users(
  max_results int default 20
)
returns table (
  user_id         uuid,
  handle          text,
  display_name    text,
  avatar_color    text,
  bio             text,
  followed_by_me  boolean,
  is_me           boolean,
  -- Appended after the seven shelf_search_users columns, never inserted among them, so
  -- ProfileSummary parses this row unchanged. Deliberate widening of the shelf-privacy
  -- line, decided against the onboarding design (p6/p7): aggregates only, never titles.
  games_in_common int,
  library_count   int,
  hours_played    numeric,
  platforms       text[]
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select pr.platforms from profiles pr where pr.user_id = (select auth.uid())
  ),
  mine as (
    select l.game_id from library_entries l where l.user_id = (select auth.uid())
  ),
  cand as (
    select pr.user_id, pr.handle, pr.display_name, pr.avatar_color, pr.bio,
           pr.platforms, pr.created_at,
           (select count(*) from library_entries l
             where l.user_id = pr.user_id)::int as library_count,
           (select count(*) from library_entries l
             where l.user_id = pr.user_id
               and l.game_id in (select game_id from mine))::int as games_in_common,
           (select sum(l.hours_played) from library_entries l
             where l.user_id = pr.user_id) as hours_played,
           (select count(*) from follows f
             where f.followee_id = pr.user_id)::int as followers,
           cardinality(array(select unnest(pr.platforms)
                             intersect
                             select unnest(coalesce((select platforms from me), '{}'))))
             as shared_platforms
      from profiles pr
     where pr.user_id <> (select auth.uid())
       and not exists (select 1 from follows f
                        where f.follower_id = (select auth.uid())
                          and f.followee_id = pr.user_id)
       -- DEFINER bypasses RLS, so this is the only thing standing between a block and a
       -- suggestion to follow the person you blocked.
       and not private.shelf_blocked_between((select auth.uid()), pr.user_id)
  )
  select c.user_id, c.handle, c.display_name, c.avatar_color, c.bio,
         -- Always false: already-followed accounts are excluded above. Present so the
         -- first seven columns stay byte-identical to shelf_search_users.
         false,
         -- Always false: self is excluded above. Same reason.
         false,
         c.games_in_common, c.library_count, c.hours_played, c.platforms
    from cand c
   order by c.library_count < 3,          -- thin shelves (fewer than 3 games) last, never cut
            c.games_in_common desc,
            c.shared_platforms desc,
            c.library_count desc,
            c.hours_played desc nulls last,
            c.followers desc,
            c.created_at, c.user_id
   limit least(greatest(max_results, 1), 50);
$$;

-- Migration 000700's rule, and it bites every time: `create or replace` restores the
-- default PUBLIC execute grant and `authenticated` inherits from PUBLIC, so anon
-- silently regains execute. On a DEFINER function that would hand an unauthenticated
-- caller the whole directory plus everyone's library size. Re-issue both, every time.
revoke all on function shelf_suggested_users(int) from public, anon;
grant execute on function shelf_suggested_users(int) to authenticated;
