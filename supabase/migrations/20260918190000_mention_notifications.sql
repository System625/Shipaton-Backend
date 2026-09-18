-- task.md §6, mentions -- smaller than the note assumes, because the app already
-- parses, resolves and links @handle itself (RichText.tsx,
-- TOKEN = /(@[a-z0-9_]{3,20}|#[A-Za-z0-9_]+)/gi) and the composer already
-- autocompletes against shelf_search_users. Nothing renders a mention from the
-- server, so no post_mentions table is needed for the app to work -- only the bell.
-- docs/research/friends-feed.md §7: decided in this pass, 18 Sep, capped at 10
-- mentions per post with the same block check every other notification kind gets.

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('follow', 'post_like', 'post_comment', 'game_release', 'post_repost', 'post_mention'));

-- Fires on insert, and on update of body only when the body actually changed
-- (editing a post without touching the text must not re-scan it). SECURITY
-- DEFINER for the same reason as the other three notify triggers: it writes a row
-- owned by someone other than the caller.
--
-- The cap is the point, not an afterthought: a 500-character body holds roughly 50
-- handles, and without a limit one post is a spam cannon that can put itself in
-- fifty strangers' notification trays. Applied at extraction, before the join to
-- profiles, so a post padded with fifty fake-looking handles cannot burn the cap
-- on garbage and crowd out the handles that do resolve -- though in practice a
-- post that does that just gets fewer real notifications sent, not more.
create or replace function private.shelf_notify_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and old.body = new.body then
    return new;
  end if;

  insert into notifications (user_id, actor_id, kind, post_id)
  select pr.user_id, new.author_id, 'post_mention', new.id
    from (
      select distinct lower(m[1]) as handle
        from regexp_matches(new.body, '@([a-z0-9_]{3,20})', 'gi') as m
       limit 10
    ) mentioned
    join profiles pr on pr.handle = mentioned.handle
   where pr.user_id <> new.author_id
     and not private.shelf_blocked_between(pr.user_id, new.author_id)
  on conflict do nothing;

  return new;
end;
$$;

revoke all on function private.shelf_notify_mentions() from public, anon;

create trigger posts_notify_mentions
  after insert or update of body on posts
  for each row execute function private.shelf_notify_mentions();
