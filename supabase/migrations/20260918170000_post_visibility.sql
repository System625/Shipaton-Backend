-- posts.visibility -- the whole of task.md §5. docs/research/friends-feed.md §7
-- decided 18 Sep: `friends` means MUTUAL follow (visible to accounts the author
-- follows *and* who follow the author back), not one-way followers -- a stranger
-- cannot add themselves to that audience by following. Measured live before
-- deciding: 389 follow edges contain 145 mutual pairs, and 32 of 33 accounts have
-- at least one, so a friends-only post has a real audience from the moment it is
-- written.
--
-- `not null default 'public'` means every existing row, and every write from the
-- app at its current HEAD (which has no audience selector at all), keeps behaving
-- exactly as it does today.
alter table posts add column visibility text not null default 'public'
  check (visibility in ('public', 'friends'));

-- No index, on purpose (this repo indexes deliberately -- 20260905000800). A
-- two-value column that will be overwhelmingly 'public', read only as one branch
-- of an OR beside two point lookups on follows' primary key -- a b-tree here would
-- never be chosen.

-- `follows`' primary key is (follower_id, followee_id), so both directions of a
-- mutual-follow check are point lookups. INVOKER, not DEFINER: follows is already
-- readable by every signed-in account (20260908213000), so there is nothing for
-- DEFINER to buy and a whole class of mistake it would open.
create or replace function private.shelf_mutual_follow(p_a uuid, p_b uuid)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (select 1 from follows where follower_id = p_a and followee_id = p_b)
     and exists (select 1 from follows where follower_id = p_b and followee_id = p_a);
$$;

revoke all on function private.shelf_mutual_follow(uuid, uuid) from public, anon;
grant execute on function private.shelf_mutual_follow(uuid, uuid) to authenticated;

-- The whole feature is this one policy: shelf_feed is SECURITY INVOKER (no
-- `security definer`, `language sql stable`), so the rows it can see are the rows
-- the caller can see under RLS -- already proven for blocks by
-- verify-social.ts:168-176, and visibility rides the identical mechanism.
drop policy "posts readable unless blocked" on posts;
create policy "posts readable unless blocked"
  on posts for select to authenticated
  using (
    not private.shelf_blocked_between((select auth.uid()), author_id)
    and (
      visibility = 'public'
      or author_id = (select auth.uid())
      or private.shelf_mutual_follow(author_id, (select auth.uid()))
    )
  );

-- Three policies that do not look at `posts` at all and so need tightening by
-- hand -- a friends-only post's likes/comments were otherwise still world-readable
-- by post id, and post_likes had no write-side check at all (post_reposts,
-- post_shares and post_comments already require `exists posts p` on insert;
-- post_likes, the oldest of the four, did not -- a live hole this closes too: a
-- blocked account could like the post it is blocked from).
drop policy "likes readable by authenticated" on post_likes;
create policy "likes readable by authenticated"
  on post_likes for select to authenticated
  using (exists (select 1 from posts p where p.id = post_id));

drop policy "own likes insert" on post_likes;
create policy "own likes insert"
  on post_likes for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from posts p where p.id = post_id)
  );

drop policy "comments readable unless blocked" on post_comments;
create policy "comments readable unless blocked"
  on post_comments for select to authenticated
  using (
    not private.shelf_blocked_between((select auth.uid()), author_id)
    and exists (select 1 from posts p where p.id = post_id)
  );

-- shelf_create_post gains p_visibility. Argument-list change -> drop + create, not
-- `create or replace` (the rule from 20260914120000 / 20260914130100 /
-- 20260917130000), and NOT an overload -- a defaulted 8th argument as a second
-- signature would leave PostgREST to pick between candidates by body keys.
-- Appended last and defaulted, so the shipped app's 7-key call still resolves.
drop function shelf_create_post(text, text, uuid, text, text, text[], int);

create function shelf_create_post(
  p_body         text,
  p_category     text    default null,
  p_game_id      uuid    default null,
  p_image_path   text    default null,
  p_link_url     text    default null,
  p_poll_options text[]  default null,
  p_poll_hours   int     default 24,
  p_visibility   text    default 'public'
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  new_id uuid;
  n integer := coalesce(array_length(p_poll_options, 1), 0);
begin
  if n = 1 or n > 4 then
    raise exception 'A poll needs 2 to 4 options' using errcode = '22023';
  end if;
  if p_visibility not in ('public', 'friends') then
    raise exception 'visibility must be public or friends' using errcode = '22023';
  end if;

  insert into posts (author_id, body, category, game_id, image_path, link_url, visibility)
  values ((select auth.uid()), btrim(p_body), p_category, p_game_id, p_image_path, p_link_url, p_visibility)
  returning id into new_id;

  if n > 0 then
    insert into post_polls (post_id, ends_at)
    values (new_id, now() + make_interval(hours => least(greatest(coalesce(p_poll_hours, 24), 1), 168)));
    insert into post_poll_options (post_id, position, label)
    select new_id, (o.ord - 1)::smallint, btrim(o.label)
      from unnest(p_poll_options) with ordinality as o(label, ord);
  end if;

  return new_id;
end;
$$;

revoke all on function shelf_create_post(text, text, uuid, text, text, text[], int, text) from public, anon;
grant execute on function shelf_create_post(text, text, uuid, text, text, text[], int, text) to authenticated;

-- Not included on purpose: no UPDATE restriction on posts.visibility beyond the
-- existing own-row policy (an author may change their mind), and no block on
-- reposting/commenting/sharing a friends-only post at the policy level beyond what
-- is already there -- `post_reposts`/`post_shares`/`post_comments` already require
-- `exists posts p` on insert, and the posts policy above already makes a hidden
-- post fail that exists check for anyone outside its audience, so those writes are
-- refused at insert with 42501, not silently ignored.
