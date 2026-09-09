-- Notifications: the bell in the app header, which is decorative today.
--
-- `LibraryScreen.tsx:215` is a `Pressable` with no `onPress`, and the only real
-- notifications in the app are local `expo-notifications` release reminders scheduled
-- on the device (`src/services/notifications/reminders.ts`). Nothing has ever arrived
-- from the server.
--
-- SCOPE, decided with the user 9 Sep 2026: an in-app inbox, and no push delivery.
-- Push would need device tokens registered app-side plus APNs/FCM credentials on the
-- prebuild native projects, which is store-submission work with three weeks to the
-- 30 Sep deadline. (For the record, because it was misremembered once: what was
-- dropped on 4 Sep was **Expo Go**, not Expo -- the app is still SDK 57 and still
-- depends on expo-notifications. Push through Expo remains available later, and
-- layering it on needs no change to this schema, only a delivery worker reading it.)
--
-- WHAT GENERATES A ROW: a follow, a like on your post, a comment on your post. All
-- three are written by triggers, not by clients -- there is no INSERT policy on this
-- table at all, so an account cannot manufacture a notification for someone else.

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  -- The recipient. Every policy on this table is about this column.
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- Who did the thing. Rendered as an avatar and a handle, so it is joined to
  -- profiles on read.
  actor_id   uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('follow', 'post_like', 'post_comment')),
  -- Both cascade: a notification about a deleted post is a dead row that would render
  -- as a blank card, and deleting the post is exactly how a user expects to be rid of
  -- it. `follow` rows carry neither.
  post_id    uuid references posts(id) on delete cascade,
  comment_id uuid references post_comments(id) on delete cascade,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  -- Liking your own post should not notify you. Enforced here as well as in the
  -- triggers so a future writer cannot reintroduce it.
  constraint no_self_notification check (user_id <> actor_id)
);

-- Dedupe, and it is doing real work in three different ways.
--
-- NULLS NOT DISTINCT (Postgres 15+; this project is on 17.6) is the whole trick.
-- Without it the two NULL columns on a `follow` row make every row distinct from
-- every other, and the constraint would never fire.
--
--   follow        (user, actor, 'follow', null, null)  -- unfollow then refollow does
--                 not ring the bell a second time, which is the obvious harassment
--                 vector on an asymmetric follow graph.
--   post_like     (user, actor, 'post_like', post, null)  -- unlike/relike likewise.
--   post_comment  comment_id is in the key, so each separate comment does notify.
--
-- Triggers insert with ON CONFLICT DO NOTHING against this index.
create unique index notifications_dedupe
  on notifications (user_id, actor_id, kind, post_id, comment_id)
  nulls not distinct;

-- The inbox itself, and its keyset pagination key -- same (created_at, id) shape as
-- shelf_feed, and for the same reason: a list that grows at the head duplicates rows
-- under OFFSET.
create index notifications_user_created on notifications (user_id, created_at desc, id desc);

-- The bell badge reads this and nothing else, on every app foreground. Partial, so it
-- indexes only the unread rows -- which is the small set, and stays small as rows are
-- marked read.
create index notifications_unread on notifications (user_id) where read_at is null;

-- The direction a cascade takes when an actor's account is deleted.
create index notifications_actor on notifications (actor_id);

alter table notifications enable row level security;

-- Read your own, delete your own, and that is the entire client surface. There is
-- deliberately NO insert policy (only the SECURITY DEFINER triggers below write) and
-- NO update policy -- marking read goes through a function that can only ever touch
-- `read_at`, so a client cannot rewrite the `kind` or the `actor_id` of its own rows
-- into something the UI renders differently.
create policy "own notifications readable"
  on notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "own notifications deletable"
  on notifications for delete to authenticated
  using (user_id = (select auth.uid()));

-- The triggers live in `private` for the reason 20260908214500 spells out: everything
-- in `public` answers at /rest/v1/rpc/. PostgREST does not expose functions returning
-- `trigger`, so this is belt and braces rather than a live hole -- but the rule is
-- cheaper to follow than to reason about each time.
--
-- SECURITY DEFINER because they insert a row owned by somebody other than the caller,
-- which is precisely what the missing INSERT policy forbids everyone else from doing.
--
-- All three check blocks. A blocked account following you, or liking its way through
-- your posts, must not be able to reach you through the bell -- the block would
-- otherwise be visible-but-mute, which is worse than no block at all.

create or replace function private.shelf_notify_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.follower_id = new.followee_id then
    return new;
  end if;
  if private.shelf_blocked_between(new.followee_id, new.follower_id) then
    return new;
  end if;
  insert into notifications (user_id, actor_id, kind)
  values (new.followee_id, new.follower_id, 'follow')
  on conflict do nothing;
  return new;
end;
$$;

create or replace function private.shelf_notify_post_like()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid;
begin
  select p.author_id into author from posts p where p.id = new.post_id;
  -- No author means the post vanished between the like and this trigger. Nothing to
  -- notify, and raising here would fail the like itself.
  if author is null or author = new.user_id then
    return new;
  end if;
  if private.shelf_blocked_between(author, new.user_id) then
    return new;
  end if;
  insert into notifications (user_id, actor_id, kind, post_id)
  values (author, new.user_id, 'post_like', new.post_id)
  on conflict do nothing;
  return new;
end;
$$;

create or replace function private.shelf_notify_post_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid;
begin
  select p.author_id into author from posts p where p.id = new.post_id;
  if author is null or author = new.author_id then
    return new;
  end if;
  if private.shelf_blocked_between(author, new.author_id) then
    return new;
  end if;
  insert into notifications (user_id, actor_id, kind, post_id, comment_id)
  values (author, new.author_id, 'post_comment', new.post_id, new.id)
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function private.shelf_notify_follow()       from public, anon;
revoke all on function private.shelf_notify_post_like()     from public, anon;
revoke all on function private.shelf_notify_post_comment()  from public, anon;

create trigger follows_notify
  after insert on follows
  for each row execute function private.shelf_notify_follow();

create trigger post_likes_notify
  after insert on post_likes
  for each row execute function private.shelf_notify_post_like();

create trigger post_comments_notify
  after insert on post_comments
  for each row execute function private.shelf_notify_post_comment();

-- The inbox, in one round trip, enriched with the actor's profile and enough of the
-- post and comment to render a card without a second query.
--
-- SECURITY INVOKER (the default) on purpose: RLS on `notifications` already confines
-- this to the caller's own rows, so there is nothing for DEFINER to buy and a whole
-- class of mistake it would open. Same keyset pagination as shelf_feed.
create or replace function shelf_notifications(
  p_limit       int         default 20,
  p_before      timestamptz default null,
  p_before_id   uuid        default null,
  p_unread_only boolean     default false
)
returns table (
  id              uuid,
  kind            text,
  created_at      timestamptz,
  read_at         timestamptz,
  actor_id        uuid,
  handle          text,
  display_name    text,
  avatar_color    text,
  post_id         uuid,
  post_excerpt    text,
  comment_id      uuid,
  comment_excerpt text
)
language sql
stable
set search_path = public
as $$
  select n.id, n.kind, n.created_at, n.read_at,
         n.actor_id, pr.handle, pr.display_name, pr.avatar_color,
         n.post_id, left(p.body, 140),
         n.comment_id, left(c.body, 140)
    from notifications n
    join profiles pr on pr.user_id = n.actor_id
    left join posts p on p.id = n.post_id
    left join post_comments c on c.id = n.comment_id
   where n.user_id = (select auth.uid())
     and (not p_unread_only or n.read_at is null)
     and (p_before is null
          or (n.created_at, n.id) < (p_before, coalesce(p_before_id, n.id)))
   order by n.created_at desc, n.id desc
   limit least(greatest(p_limit, 1), 50);
$$;

-- What the bell badge calls. Kept separate from shelf_notifications so foregrounding
-- the app does not have to fetch and discard twenty rows to draw a number.
create or replace function shelf_unread_notification_count()
returns bigint
language sql
stable
set search_path = public
as $$
  select count(*) from notifications
   where user_id = (select auth.uid()) and read_at is null;
$$;

-- Mark read. SECURITY DEFINER, and takes NO user id -- the same rule that keeps
-- shelf_popular_with_friends safe. DEFINER because there is no UPDATE policy on the
-- table by design; routing the write through here means `read_at` is the only column
-- that can ever change, and the `user_id = auth.uid()` predicate means ids belonging
-- to somebody else are silently ignored rather than updated.
--
-- Null p_ids marks everything read, which is the "opened the bell" case; a list marks
-- just those, which is the "tapped one row" case. Returns how many actually changed,
-- so the client can update the badge without a second round trip.
create or replace function shelf_mark_notifications_read(p_ids uuid[] default null)
returns bigint
language sql
volatile
security definer
set search_path = public
as $$
  with updated as (
    update notifications
       set read_at = now()
     where user_id = (select auth.uid())
       and read_at is null
       and (p_ids is null or id = any (p_ids))
    returning 1
  )
  select count(*) from updated;
$$;

revoke all on function shelf_notifications(int, timestamptz, uuid, boolean) from public, anon;
revoke all on function shelf_unread_notification_count()                    from public, anon;
revoke all on function shelf_mark_notifications_read(uuid[])                from public, anon;
grant execute on function shelf_notifications(int, timestamptz, uuid, boolean) to authenticated;
grant execute on function shelf_unread_notification_count()                    to authenticated;
grant execute on function shelf_mark_notifications_read(uuid[])                to authenticated;
