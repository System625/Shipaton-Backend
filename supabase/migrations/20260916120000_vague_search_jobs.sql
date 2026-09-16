-- Vague search: the job table and the async plumbing around it.
--
-- docs/research/semantic-search.md §7/§11: the model call behind step 3 measured
-- median 25.7s, p90 68.8s, **max 227.5s** over 71 real queries. That maximum is
-- longer than a Supabase edge function is allowed to run at all (150s wall clock),
-- which is true of every invocation, foreground or background -- there is no way
-- to `await` that fetch to completion inside one function call and stay inside the
-- platform's own limit. So this cannot be "POST, then wait a bit" like every other
-- endpoint in this project. It has to be a job row plus a sweep, the same shape as
-- `push-sweep` / `notifications`, not a single long-lived request.
--
-- Judgment call, flagged as such: rather than a single sweep invocation awaiting
-- one slow model call and risking the same 150s wall clock mid-flight, each sweep
-- pass bounds its own wait (see vague-search-sweep) and, on timeout, puts the job
-- back to 'pending' for the next pass rather than failing it outright. `attempts`
-- caps that at 3 tries before it becomes a real, reported failure.
create table vague_search_jobs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  query        text not null,
  status       text not null default 'pending'
               check (status in ('pending', 'processing', 'done', 'error')),
  attempts     int  not null default 0,
  -- When a claim last flipped this to 'processing' -- NOT when the row was
  -- created. The reclaim check below needs this distinction: a job that sat
  -- 'pending' for a while (a busy sweep queue) must not look like a stale claim
  -- the moment it is finally picked up.
  claimed_at   timestamptz,
  -- [{gameId, title, score}], grounded and ordered best-first. Never a title the
  -- catalog could not confirm -- shelf_ground_titles is the only thing that can
  -- populate this, so an unresolved model guess simply never appears here.
  candidates   jsonb not null default '[]'::jsonb,
  -- The model's confidence in candidates[0], 0-1. Null on a cache hit, since
  -- search_cache does not carry it. Whether/where to threshold this into a "we're
  -- not sure" UI state is a product decision for Paul (§11 step 6) and is
  -- deliberately NOT made here -- the raw number is returned as-is.
  confidence   real,
  from_cache   boolean not null default false,
  error        text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- The client polls its own job by id; RLS below scopes this for free, but the
-- index is what keeps that poll cheap.
create index vague_search_jobs_user on vague_search_jobs (user_id, created_at desc);

-- What the sweep scans: oldest pending (or timed-out processing) job first.
create index vague_search_jobs_pending on vague_search_jobs (created_at)
  where status in ('pending', 'processing');

alter table vague_search_jobs enable row level security;

-- Read your own, and create your own. No update or delete policy -- exactly the
-- notifications precedent (20260909121000_notifications.sql): every write past
-- creation goes through a SECURITY DEFINER function below, none of which are
-- reachable by `authenticated`, so a client cannot mark its own job done, retry a
-- failure, or edit another user's candidates.
create policy "own vague search jobs readable"
  on vague_search_jobs for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own vague search jobs insertable"
  on vague_search_jobs for insert to authenticated
  with check (user_id = (select auth.uid()));

-- Cache lookup for the interactive path. Reads `search_cache` (created
-- 20260905000100_catalog.sql), which has RLS enabled and NO policy at all -- so
-- only a SECURITY DEFINER function (or the service role) can ever touch it. This
-- is the "wired to nothing" table docs/research/semantic-search.md §6/§8 step 4
-- names as the cache to use.
--
-- 30-day freshness is a judgment call, not a measurement: unlike /search's live
-- catalog lookups, a vague-search answer names a specific game that does not stop
-- being the answer, so this can be generous. Revisit if a genre reboot or remake
-- ever makes an old cached answer wrong.
create function shelf_vague_search_cache_get(p_query text)
returns uuid[]
language sql
stable
security definer
set search_path = public, extensions
as $$
  select game_ids
    from search_cache
   where query_norm = shelf_match_title(p_query)
     and fetched_at > now() - interval '30 days';
$$;

revoke all on function shelf_vague_search_cache_get(text) from public, anon;
grant execute on function shelf_vague_search_cache_get(text) to authenticated;

-- Everything past this point is sweep-only, same security model as
-- shelf_next_push_batch (20260915160000_push_pushed_at.sql): revoked from
-- `authenticated` entirely, callable only by the service role the sweep function
-- authenticates as. A user has no business claiming, completing or failing
-- anyone's job, including their own -- that is what the two policies above are for.

create function shelf_vague_search_cache_put(p_query text, p_game_ids uuid[])
returns void
language sql
security definer
set search_path = public, extensions
as $$
  insert into search_cache (query_norm, game_ids, fetched_at)
  values (shelf_match_title(p_query), p_game_ids, now())
  on conflict (query_norm) do update
    set game_ids = excluded.game_ids, fetched_at = excluded.fetched_at;
$$;

-- Claims a batch for one sweep pass. `for update skip locked` so two overlapping
-- sweep runs (a slow previous pass plus a new scheduled one) split the work
-- instead of racing on the same rows -- same reason shelf_next_push_batch does it.
-- A 'processing' row claimed more than 5 minutes ago is reclaimed: the only way a
-- job stays 'processing' that long is the sweep invocation that claimed it being
-- killed by the platform mid-call (the 150s wall clock this whole design works
-- around), not genuine ongoing work. Keyed on `claimed_at`, not `created_at` --
-- a job that simply waited its turn in a busy queue must not look stale the
-- moment it is finally picked up.
create function shelf_vague_search_claim_batch(p_limit int default 5)
returns setof vague_search_jobs
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  update vague_search_jobs j
     set status = 'processing', claimed_at = now()
    from (
      select id from vague_search_jobs
       where (status = 'pending')
          or (status = 'processing' and claimed_at < now() - interval '5 minutes')
       order by created_at
       limit greatest(p_limit, 1)
         for update skip locked
    ) claimed
   where j.id = claimed.id
  returning j.*;
end;
$$;

create function shelf_vague_search_job_complete(p_job_id uuid, p_candidates jsonb, p_confidence real)
returns void
language sql
security definer
set search_path = public, extensions
as $$
  update vague_search_jobs
     set status = 'done', candidates = p_candidates, confidence = p_confidence,
         completed_at = now()
   where id = p_job_id;
$$;

-- p_retry lets the sweep distinguish "the model call timed out, try again" from
-- "attempts are exhausted, this is a real failure" without two separate functions.
create function shelf_vague_search_job_fail(p_job_id uuid, p_error text, p_retry boolean)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if p_retry then
    update vague_search_jobs
       set status = case when attempts + 1 >= 3 then 'error' else 'pending' end,
           attempts = attempts + 1,
           error = p_error,
           completed_at = case when attempts + 1 >= 3 then now() else null end
     where id = p_job_id;
  else
    update vague_search_jobs
       set status = 'error', error = p_error, completed_at = now()
     where id = p_job_id;
  end if;
end;
$$;

revoke all on function shelf_vague_search_cache_put(text, uuid[]) from public, anon, authenticated;
revoke all on function shelf_vague_search_claim_batch(int) from public, anon, authenticated;
revoke all on function shelf_vague_search_job_complete(uuid, jsonb, real) from public, anon, authenticated;
revoke all on function shelf_vague_search_job_fail(uuid, text, boolean) from public, anon, authenticated;
-- service_role bypasses grants entirely, same as shelf_next_push_batch -- these
-- four are reachable only through the sweep function's service-role client.
