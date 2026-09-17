-- Extends `notifications` (20260909121000) for the Release-Day Tracker's
-- watch-notify path -- Session B of the Events build, docs/research/events-
-- screen.md §3/§4. A release has no actor, so three of that table's constraints
-- have to move before a `game_release` row can exist at all:
--
--   actor_id uuid NOT NULL                                   -> made nullable
--   kind check (in ('follow','post_like','post_comment'))    -> + 'game_release'
--   no_self_notification check (user_id <> actor_id)         -> actor_id is null OR ...
--
-- and the table needs somewhere to point: a nullable game_id, cascading with the
-- game the same way post_id/comment_id cascade with their rows -- a notification
-- about a game that later gets merged or removed is a dead row, not a rendering
-- bug to handle client-side.

alter table notifications alter column actor_id drop not null;

alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('follow', 'post_like', 'post_comment', 'game_release'));

alter table notifications drop constraint no_self_notification;
alter table notifications add constraint no_self_notification
  check (actor_id is null or user_id <> actor_id);

alter table notifications add column game_id uuid references games(id) on delete cascade;

-- Cheap guard against the exact failure this project keeps hitting -- release_tbd,
-- roulette's `hours`, a column that exists and is quietly never populated. A
-- game_release row with no game_id would render as a blank card the same way a
-- deleted post's stray notification would; this makes that shape impossible to
-- insert rather than trusting every future writer to remember it.
alter table notifications add constraint game_release_has_game
  check (kind <> 'game_release' or game_id is not null);

-- FK index, same rule as notifications_actor.
create index notifications_game on notifications (game_id);

-- The dedupe index needs game_id in its key, so it is rebuilt rather than altered
-- in place. Same NULLS NOT DISTINCT trick as before: a game_release row carries a
-- null actor_id/post_id/comment_id, so this collapses to uniqueness on
-- (user_id, kind, game_id) for that kind -- one bell ring per watcher per release,
-- ever, no matter how many times the sweep below runs.
drop index notifications_dedupe;
create unique index notifications_dedupe
  on notifications (user_id, actor_id, kind, post_id, comment_id, game_id)
  nulls not distinct;

-- ---------------------------------------------------------------------------
-- The inbox RPC: adds game_id/title/cover so a game_release card renders without
-- a second round trip, same reasoning as the post/comment excerpts it already
-- carries. The return type changes, so this drops rather than replaces (same rule
-- as 20260914120000 and 20260914130100).
--
-- The join to profiles also changes from an INNER join to a LEFT join here. It was
-- silently fine while every kind had a non-null actor_id; a game_release row has
-- none, and an inner join would have dropped every one of them out of the inbox
-- with no error -- the caller would just never see them. Same shape bug as the
-- push batch fixed in the next migration.
-- ---------------------------------------------------------------------------
drop function if exists shelf_notifications(int, timestamptz, uuid, boolean);

create function shelf_notifications(
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
  comment_excerpt text,
  game_id         uuid,
  game_title      text,
  game_cover_url  text
)
language sql
stable
set search_path = public
as $$
  select n.id, n.kind, n.created_at, n.read_at,
         n.actor_id, pr.handle, pr.display_name, pr.avatar_color,
         n.post_id, left(p.body, 140),
         n.comment_id, left(c.body, 140),
         n.game_id, g.title, g.cover_url
    from notifications n
    left join profiles pr on pr.user_id = n.actor_id
    left join posts p on p.id = n.post_id
    left join post_comments c on c.id = n.comment_id
    left join games g on g.id = n.game_id
   where n.user_id = (select auth.uid())
     and (not p_unread_only or n.read_at is null)
     and (p_before is null
          or (n.created_at, n.id) < (p_before, coalesce(p_before_id, n.id)))
   order by n.created_at desc, n.id desc
   limit least(greatest(p_limit, 1), 50);
$$;

revoke all on function shelf_notifications(int, timestamptz, uuid, boolean) from public, anon;
grant execute on function shelf_notifications(int, timestamptz, uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- The writer. Nothing about a game's lifecycle fires an INSERT the way a follow
-- or a like does, so this is not a trigger -- it is a query, run on a schedule by
-- game-release-sweep (the edge function), the same firing decision push-sweep
-- made and for the same reasons (20260915160000): a scheduled sweep is one code
-- path to secure instead of several, and it never makes a user's own action wait
-- on anything external.
--
-- release_precision = 'day' ONLY. This is the entire reason Session A shipped
-- first: anything less precise means "today" is matching IGDB's end-of-period
-- placeholder (31 Dec, a quarter-end), not an announced date --
-- research/events-screen.md measured that as 80.4% of upcoming releases. Matching
-- on release_date alone here would recreate exactly the failure this was built to
-- avoid.
--
-- SECURITY DEFINER: it inserts rows owned by every watcher, exactly what the
-- missing INSERT policy on notifications forbids everyone else from doing -- same
-- shape as the three shelf_notify_* triggers. ON CONFLICT DO NOTHING against
-- notifications_dedupe: a real release date does not recur, but a sweep interval
-- that runs more than once on release day must not ring the bell twice.
create or replace function shelf_sweep_game_releases()
returns int
language sql
volatile
security definer
set search_path = public
as $$
  with due as (
    select id as game_id
      from games
     where release_date = current_date
       and release_precision = 'day'
  ),
  ins as (
    insert into notifications (user_id, actor_id, kind, game_id)
    select gw.user_id, null, 'game_release', d.game_id
      from due d
      join game_watches gw on gw.game_id = d.game_id
    on conflict do nothing
    returning 1
  )
  select count(*)::int from ins;
$$;

-- Service role only -- called by game-release-sweep on a schedule, same posture
-- as shelf_set_release_precision and shelf_next_push_batch.
revoke all on function shelf_sweep_game_releases() from public, anon, authenticated;
