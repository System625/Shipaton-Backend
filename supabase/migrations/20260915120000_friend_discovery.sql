-- Friend discovery: finding a person, and seeing who is in a follow list.
--
-- The social graph has been complete since 8 Sep except for the one thing that makes
-- it usable: there is no way to FIND anybody. `followUser` works, tapping a name in
-- the feed opens a profile, and `shelf_profile_stats` returns follower and following
-- COUNTS -- but nothing returns the members of those lists, and nothing searches
-- profiles. So an account can only follow someone whose exact handle it already
-- knows, which in practice means nobody follows anybody. Raised by Sola 15 Sep.
--
-- Three functions, one row shape. All of them return the same seven profile columns,
-- so the app writes one profile-row component and one type and uses it for search
-- results, the followers list and the following list.
--
-- The two list functions return one column more: `followed_at`, the moment the follow
-- was created. It is not decoration -- it is the pagination cursor. These lists page
-- by keyset on (created_at, user id), so the caller has to be able to send back the
-- created_at of the last row it saw, and a cursor the client cannot read is a cursor
-- that does not work. It is also the obvious thing to render as "followed you on ...".

-- ---------------------------------------------------------------------------
-- 1. Indexes for prefix search
-- ---------------------------------------------------------------------------
-- `handle` already has a unique btree from 20260908213000, and it is NOT usable for
-- `like 'paul%'`. A btree only answers a prefix LIKE when its opclass is
-- text_pattern_ops, or the database collation is C -- this project is on en_US.UTF-8,
-- so the default-collation index is skipped and the query seq-scans profiles.
-- Verified rather than assumed: `explain` on the search below picks these two.
create index if not exists profiles_handle_prefix
  on profiles (handle text_pattern_ops);

-- Display names are matched case-insensitively, so the index has to be on the same
-- expression the query uses, lower() and all, or it will not be chosen either.
create index if not exists profiles_display_name_prefix
  on profiles (lower(display_name) text_pattern_ops);

-- ---------------------------------------------------------------------------
-- 2. User search
-- ---------------------------------------------------------------------------
-- PREFIX, NOT FUZZY, and deliberately not the trigram machinery that `games` uses.
-- A catalog search is a guess at a title somebody half-remembers; a people search is
-- someone typing a handle they were told. Fuzzy matching there surfaces strangers
-- whose names merely resemble the query, which is a worse answer and a mild privacy
-- smell. Sola asked for prefix and prefix is the right call.
--
-- SECURITY INVOKER (the default). `profiles` is readable by every authenticated user
-- by policy, so this function grants no visibility that a direct
-- `.from('profiles').select()` would not -- it exists to add block filtering,
-- ranking, and `followed_by_me` in one round trip instead of three.
create or replace function shelf_search_users(
  q           text,
  max_results int default 20
)
returns table (
  user_id        uuid,
  handle         text,
  display_name   text,
  avatar_color   text,
  bio            text,
  followed_by_me boolean,
  is_me          boolean
)
language plpgsql
stable
set search_path = public
as $$
declare
  needle  text := lower(btrim(coalesce(q, '')));
  pattern text;
begin
  -- Same two-character floor as /search, and here it is load-bearing rather than
  -- tidiness: a one-character prefix matches a large fraction of the table and the
  -- index stops being worth using.
  if length(needle) < 2 then
    return;
  end if;

  -- `_` IS A LEGAL HANDLE CHARACTER and it is also the LIKE single-character
  -- wildcard. Unescaped, a search for `paul_` matches `paula`, `paulb`, `pauls` --
  -- every five-character handle starting `paul`. Escape all three metacharacters,
  -- backslash first or it would double-escape the escapes that follow.
  pattern := replace(replace(replace(needle, '\', '\\'), '%', '\%'), '_', '\_') || '%';

  return query
  select pr.user_id, pr.handle, pr.display_name, pr.avatar_color, pr.bio,
         exists (select 1 from follows f
                  where f.follower_id = (select auth.uid())
                    and f.followee_id = pr.user_id),
         -- Always false: self is excluded below. Present so that all three functions
         -- in this migration return an identical row and the app needs one type.
         false
    from profiles pr
   where (pr.handle like pattern escape '\'
          or lower(pr.display_name) like pattern escape '\')
     -- You are not a search result to yourself. `no_self_follow` means the only
     -- action the row offers is impossible.
     and pr.user_id <> (select auth.uid())
     -- Mutual hide, the same rule the feed and the notification triggers apply. A
     -- blocked account must not be findable by the person who blocked it, and must
     -- not be able to find them either -- a block that leaves search working is
     -- visible-but-mute, which is worse than no block.
     and not private.shelf_blocked_between((select auth.uid()), pr.user_id)
   order by
     -- An exact handle is what somebody typing a handle meant. It wins outright.
     (pr.handle = needle) desc,
     -- Then handle prefix over display-name prefix: handles are unique and typed
     -- deliberately, display names are neither.
     (pr.handle like pattern escape '\') desc,
     -- Shorter is closer to the query when both are prefixes of it.
     length(pr.handle),
     pr.handle
   limit least(greatest(max_results, 1), 50);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The follow lists
-- ---------------------------------------------------------------------------
-- Keyset pagination on (created_at, id), the same shape as shelf_feed and
-- shelf_notifications and for the same reason: these lists grow at the head, and
-- OFFSET duplicates rows when something is inserted between two page fetches.
--
-- `follows` has no id column -- its primary key is the pair -- so the tiebreak is the
-- other party's uuid, which is unique within one list and stable. Hence p_before_id
-- meaning "the follower_id of the last row" in one function and "the followee_id of
-- the last row" in the other; in both cases it is simply the `user_id` the previous
-- page's last row carried, so the app passes the same field either way.

create or replace function shelf_followers(
  p_handle    text,
  p_limit     int         default 20,
  p_before    timestamptz default null,
  p_before_id uuid        default null
)
returns table (
  user_id        uuid,
  handle         text,
  display_name   text,
  avatar_color   text,
  bio            text,
  followed_by_me boolean,
  is_me          boolean,
  -- The keyset cursor. Pass it straight back as p_before for the next page.
  followed_at    timestamptz
)
language sql
stable
set search_path = public
as $$
  select pr.user_id, pr.handle, pr.display_name, pr.avatar_color, pr.bio,
         exists (select 1 from follows me
                  where me.follower_id = (select auth.uid())
                    and me.followee_id = pr.user_id),
         pr.user_id = (select auth.uid()),
         f.created_at
    from follows f
    join profiles target on target.user_id = f.followee_id
    join profiles pr     on pr.user_id     = f.follower_id
   where target.handle = lower(p_handle)
     -- Blocks apply to the list's CONTENTS, not to the profile being viewed. Someone
     -- I have blocked is removed from whosever follower list I am reading.
     and not private.shelf_blocked_between((select auth.uid()), pr.user_id)
     and (p_before is null
          or (f.created_at, f.follower_id) < (p_before, coalesce(p_before_id, f.follower_id)))
   order by f.created_at desc, f.follower_id desc
   limit least(greatest(p_limit, 1), 50);
$$;

create or replace function shelf_following(
  p_handle    text,
  p_limit     int         default 20,
  p_before    timestamptz default null,
  p_before_id uuid        default null
)
returns table (
  user_id        uuid,
  handle         text,
  display_name   text,
  avatar_color   text,
  bio            text,
  followed_by_me boolean,
  is_me          boolean,
  -- The keyset cursor. Pass it straight back as p_before for the next page.
  followed_at    timestamptz
)
language sql
stable
set search_path = public
as $$
  select pr.user_id, pr.handle, pr.display_name, pr.avatar_color, pr.bio,
         exists (select 1 from follows me
                  where me.follower_id = (select auth.uid())
                    and me.followee_id = pr.user_id),
         pr.user_id = (select auth.uid()),
         f.created_at
    from follows f
    join profiles target on target.user_id = f.follower_id
    join profiles pr     on pr.user_id     = f.followee_id
   where target.handle = lower(p_handle)
     and not private.shelf_blocked_between((select auth.uid()), pr.user_id)
     and (p_before is null
          or (f.created_at, f.followee_id) < (p_before, coalesce(p_before_id, f.followee_id)))
   order by f.created_at desc, f.followee_id desc
   limit least(greatest(p_limit, 1), 50);
$$;

-- `follows_followee` from 20260908213000 covers the followers direction, and the
-- primary key covers the following direction. Both are (id, ...) leading, so the
-- keyset sort on created_at is a sort of one person's follow rows, not of the table.

-- ---------------------------------------------------------------------------
-- 4. Grants
-- ---------------------------------------------------------------------------
-- Migration 000700's rule, and it bites every time a function is created or replaced:
-- `create or replace` restores the default PUBLIC execute grant and `authenticated`
-- inherits from PUBLIC, so anon silently regains execute. Re-issue both, every time.
-- Check with: select proname, proacl from pg_proc where proname like 'shelf_search_users';
revoke all on function shelf_search_users(text, int)                        from public, anon;
revoke all on function shelf_followers(text, int, timestamptz, uuid)        from public, anon;
revoke all on function shelf_following(text, int, timestamptz, uuid)        from public, anon;
grant execute on function shelf_search_users(text, int)                     to authenticated;
grant execute on function shelf_followers(text, int, timestamptz, uuid)     to authenticated;
grant execute on function shelf_following(text, int, timestamptz, uuid)     to authenticated;
