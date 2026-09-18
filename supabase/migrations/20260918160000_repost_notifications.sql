-- The only genuinely missing piece of task.md §4: reposting is silent today.
-- docs/research/friends-feed.md §3 -- counted live 18 Sep, 24 reposts have already
-- happened and notified nobody.
--
-- Same shape as post_likes_notify / post_comments_notify (20260909121000): a
-- SECURITY DEFINER trigger in `private`, because it writes a row owned by someone
-- other than the caller -- exactly what the missing INSERT policy on notifications
-- forbids everyone else from doing.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('follow', 'post_like', 'post_comment', 'game_release', 'post_repost'));

create or replace function private.shelf_notify_post_repost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid;
begin
  select p.author_id into author from posts p where p.id = new.post_id;
  -- No author means the post vanished between the repost and this trigger --
  -- nothing to notify, and raising here would fail the repost itself.
  if author is null or author = new.user_id then
    return new;
  end if;
  if private.shelf_blocked_between(author, new.user_id) then
    return new;
  end if;
  insert into notifications (user_id, actor_id, kind, post_id)
  values (author, new.user_id, 'post_repost', new.post_id)
  on conflict do nothing;
  return new;
end;
$$;

revoke all on function private.shelf_notify_post_repost() from public, anon;

create trigger post_reposts_notify
  after insert on post_reposts
  for each row execute function private.shelf_notify_post_repost();
