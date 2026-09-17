-- Extends the push worker's read query (shelf_next_push_batch, 20260915160000)
-- for game_release rows, whose actor_id is null by design (previous migration).
--
-- The original join was `join profiles pr on pr.user_id = n.actor_id` -- an INNER
-- join. A null actor_id joins nothing, so it would have silently dropped every
-- game_release row out of the push batch rather than erroring: the bell rings
-- (shelf_notifications already left-joins and shows the card) but the push that
-- was supposed to bring someone back to the app never goes out, with nothing in
-- any log to say so. That is the same "looks wired, isn't" shape as release_tbd
-- and roulette's `hours` -- caught here, before ONESIGNAL credentials exist to
-- ever run this path for real, rather than by whoever flips them on later.
--
-- Return type changes (adds game_title), so this drops rather than replaces, same
-- rule as shelf_notifications just above it.
drop function if exists shelf_next_push_batch(int);

create function shelf_next_push_batch(p_limit int default 200)
returns table (
  id                  uuid,
  user_id             uuid,
  kind                text,
  actor_display_name  text,
  game_title          text
)
language sql
stable
security invoker
set search_path = public
as $$
  select n.id, n.user_id, n.kind, pr.display_name, g.title
    from notifications n
    left join profiles pr on pr.user_id = n.actor_id
    left join games g on g.id = n.game_id
   where n.pushed_at is null
   order by n.created_at asc
   limit least(greatest(p_limit, 1), 500);
$$;

-- Never granted to authenticated -- unchanged posture from 20260915160000. This
-- reads across every user's notifications; the only caller is push-sweep's
-- service-role client, which bypasses grants entirely.
revoke all on function shelf_next_push_batch(int) from public, anon, authenticated;
