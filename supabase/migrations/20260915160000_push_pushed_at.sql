-- Push worker groundwork, item 13 of the OneSignal plan
-- (docs/research/push-notifications.md): a `pushed_at` column on `notifications`.
--
-- WHY THIS IS A REAL SCHEMA CHANGE AND NOT JUST A DELIVERY DETAIL. The existing
-- `notifications_dedupe` index (20260909121000) stops duplicate BELL ROWS -- unfollow
-- then refollow does not ring the bell twice. It says nothing about duplicate SENDS.
-- A push worker that retries after a timeout, or a scheduled sweep that runs again
-- before the last one finished, would happily push the same row twice with no column
-- to check first. `pushed_at is null` is that check, and it is also the natural
-- work queue: "select where pushed_at is null" is the whole read side of the sweep.
--
-- FIRING DECISION (item 12): a scheduled sweep, not a trigger-on-insert send.
-- Reasons, not just a coin flip:
--   1. The three notify triggers (shelf_notify_follow/post_like/post_comment) run
--      SECURITY DEFINER inside the same transaction as the like/follow/comment
--      itself. Firing an external HTTP call from inside that transaction means a
--      slow or down OneSignal call blocks or fails the user's actual action --
--      liking a post should never depend on a third party's uptime.
--   2. One code path to secure and test (this function) instead of three call sites
--      wired into triggers that already have a lot going on.
--   3. `pushed_at` is a natural, idempotent retry marker for a sweep in a way it
--      is not for a fire-and-forget call: a sweep that dies partway through just
--      picks up the unpushed rows again next run.
-- The cost is latency -- up to one sweep interval before a push goes out -- which is
-- the right trade for a notification, not a chat message.

alter table notifications add column pushed_at timestamptz;

-- The sweep's read query in full: "the oldest unpushed rows, in order". Partial so
-- it indexes only the ones that matter -- the same shape as notifications_unread,
-- and for the same reason: this set stays small if the sweep runs often enough,
-- however large the table gets.
create index notifications_unpushed on notifications (created_at) where pushed_at is null;

-- What push-sweep reads. There is no FK from notifications to profiles for
-- PostgREST to embed through -- notifications.actor_id and profiles.user_id both
-- point at auth.users independently, the same reason shelf_notifications() (the
-- inbox RPC, same file) does this join in SQL rather than leaning on an embed.
-- Written the same way for the same reason, not because push needed a new pattern.
--
-- NEVER GRANTED TO authenticated. This reads across every user's notifications and
-- names other people's actors; the only caller is push-sweep's service-role client,
-- which bypasses grants entirely, so the revoke below is what actually matters.
create or replace function shelf_next_push_batch(p_limit int default 200)
returns table (
  id                  uuid,
  user_id             uuid,
  kind                text,
  actor_display_name  text
)
language sql
stable
security invoker
set search_path = public
as $$
  select n.id, n.user_id, n.kind, pr.display_name
    from notifications n
    join profiles pr on pr.user_id = n.actor_id
   where n.pushed_at is null
   order by n.created_at asc
   limit least(greatest(p_limit, 1), 500);
$$;

revoke all on function shelf_next_push_batch(int) from public, anon, authenticated;
