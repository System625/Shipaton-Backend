-- Fix: shelf_resolve_external_ids was being silently truncated at 1,000 rows.
--
-- FOUND 14 Sep 2026 by importing a real 4,652-game Steam library through the
-- deployed endpoint. It reported 1,000 matches where a direct measurement of the
-- same library found 1,797 — and "1,000" is not a number a matcher produces, it is
-- PostgREST's default `max-rows`. Counter-Strike 2 was in the *unmatched* list.
--
-- The function was right; returning `setof` was the mistake. PostgREST paginates a
-- set-returning RPC exactly like a table, so anything past the cap is dropped with
-- no error, no warning and no truncation flag. Every check short of counting the
-- rows passed: the import succeeded, wrote real games, and looked fine.
--
-- THE SHAPE OF THIS BUG IS THE POINT. A cap that silently discards the tail is the
-- same failure as `SEED_MIN_POPULARITY` being read by no code — the system reports
-- success while doing a fraction of the work, so only a number you already knew the
-- answer to reveals it. Chunking the caller at 500 would have worked today and
-- broken again the moment anyone changed `max-rows`. Returning ONE row makes the
-- limit structurally unreachable instead of merely distant.
--
-- The return type changes, so this drops rather than replaces.

drop function if exists shelf_resolve_external_ids(text, text[]);

create function shelf_resolve_external_ids(p_source text, p_uids text[])
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions
as $$
  -- One row, one jsonb array, no pagination to apply. '[]' rather than null when
  -- nothing matches, so the caller never has to special-case an empty library.
  select coalesce(jsonb_agg(jsonb_build_object(
           'uid', r.uid, 'game_id', r.game_id, 'via_parent', r.via_parent)), '[]'::jsonb)
  from (
    select distinct on (e.uid) e.uid, e.game_id, e.via_parent
    from game_external_ids e
    where e.source = p_source
      and e.uid = any(p_uids)
    -- Preference order, unchanged: a direct edge beats a parent hop, then lowest
    -- igdb_id. Arbitrary but STABLE — re-running an import must not shuffle a
    -- library.
    order by e.uid, e.via_parent asc, e.igdb_id asc
  ) r;
$$;

-- `create function` in public picks up Supabase's default-privileges grant to anon,
-- so revoking PUBLIC alone leaves an explicit anon=X behind. Both have to go — see
-- migration 20260905000700, which exists because that was missed once already.
revoke all on function shelf_resolve_external_ids(text, text[]) from public, anon;
grant execute on function shelf_resolve_external_ids(text, text[]) to authenticated, service_role;
