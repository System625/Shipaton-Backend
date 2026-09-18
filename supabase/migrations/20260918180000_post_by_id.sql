-- shelf_post(p_post_id) -- not in task.md, but asked for in the app's own source
-- (src/services/social/feed.ts:72): "There's no direct 'fetch one post by id'
-- endpoint yet, so this pages through an author's own feed looking for it."
-- Every tap on a like/comment notification currently runs findPostById, up to
-- four pages of shelf_feed (200 fully-joined rows) to find one post -- and it only
-- works for the caller's own posts, so a repost or mention notification could
-- never open its post at all.
--
-- shelf_feed's projection (26 of 29 live columns; the other 3 -- reposted_by_handle,
-- reposted_by_name, reason -- depend on the caller's ranking, not the post) has
-- already drifted once, badly: this repo's copy said 16 columns while live
-- returned 29, and 20260918120000 exists because a `create or replace` from the
-- stale copy would have silently deleted thirteen of them. Writing shelf_post as a
-- second hand-copy of that projection guarantees a second drift, so it is factored
-- into a view instead and both functions read the same definition.

-- SECURITY_INVOKER = on (Postgres 15+; this project is 17.6) is load-bearing: a
-- view defaults to running as its owner, which would hand every caller every post
-- and undo 20260918170000's visibility policy completely. Function calls are
-- schema-qualified inside it -- a view carries no `set search_path` of its own
-- the way a function does, so this is what pins it to `public` regardless of the
-- caller's session search_path.
create view private.post_cards with (security_invoker = on) as
  select p.id, p.body, p.link_url, p.image_path, p.created_at, p.edited_at,
         p.author_id, pr.handle, pr.display_name, pr.avatar_color,
         p.category, p.visibility,
         g.id as game_id, g.title as game_title, g.cover_url as game_cover,
         g.artwork_url as game_artwork,
         extract(year from g.release_date)::integer as game_year,
         g.genres as game_genres,
         case when g.critic_score is null then null
              else round(g.critic_score / 20.0, 1) end as game_rating,
         (select array_agg(distinct pl.family)
            from public.game_platforms gp join public.platforms pl on pl.id = gp.platform_id
           where gp.game_id = g.id and pl.family is not null) as game_platforms,
         public.shelf_poll(p.id) as poll,
         (select count(*) from public.post_likes l where l.post_id = p.id) as like_count,
         (select count(*) from public.post_comments c where c.post_id = p.id) as comment_count,
         (select count(*) from public.post_reposts r where r.post_id = p.id) as repost_count,
         (select count(*) from public.post_shares sh where sh.post_id = p.id) as share_count,
         exists (select 1 from public.post_likes l
                  where l.post_id = p.id and l.user_id = (select auth.uid())) as liked_by_me,
         exists (select 1 from public.post_reposts r
                  where r.post_id = p.id and r.user_id = (select auth.uid())) as reposted_by_me
    from posts p
    join profiles pr on pr.user_id = p.author_id
    left join games g on g.id = p.game_id;

-- `private`, not `public` -- everything in `public` is a public API (PostgREST
-- exposes tables and views there exactly as it exposes functions). A `public`
-- post_cards would appear at /rest/v1/post_cards as a new, arbitrarily filterable
-- read surface, and `authenticated` would have to hold SELECT on it for the
-- invoker functions below to work, so it could not simply be revoked afterwards.
-- Same answer 20260908214500 reached for shelf_blocked_between, for the same
-- reason -- `authenticated` already has USAGE on `private`.
revoke all on private.post_cards from public, anon;
grant select on private.post_cards to authenticated;

-- shelf_feed rewritten over the view. Same me/following/network/reposts/popular/
-- scoped CTEs and the same ranking, verbatim -- `scoped` still reads `posts`
-- directly for the filtering logic (RLS already confines it to what the caller
-- may see, visibility included, since this function stays SECURITY INVOKER) --
-- only the final projection changes, to `private.post_cards` plus the three
-- caller-context columns the view cannot know: reposted_by_handle,
-- reposted_by_name, reason. Return type changes (visibility is new), so this
-- drops rather than replaces, same rule as every other function here whose
-- signature or shape changed.
drop function shelf_feed(int, timestamptz, uuid, text);

create function shelf_feed(
  p_limit     int         default 20,
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_handle    text        default null
)
returns table (
  id                 uuid,
  body               text,
  link_url           text,
  image_path         text,
  created_at         timestamptz,
  edited_at          timestamptz,
  author_id          uuid,
  handle             text,
  display_name       text,
  avatar_color       text,
  category           text,
  visibility         text,
  game_id            uuid,
  game_title         text,
  game_cover         text,
  game_artwork       text,
  game_year          int,
  game_genres        text[],
  game_rating        numeric,
  game_platforms     text[],
  poll               jsonb,
  like_count         bigint,
  comment_count      bigint,
  repost_count       bigint,
  share_count        bigint,
  liked_by_me        boolean,
  reposted_by_me     boolean,
  reposted_by_handle text,
  reposted_by_name   text,
  reason             text
)
language sql
stable
set search_path = public
as $$
  with me as (
    select (select auth.uid()) as uid
  ),
  following as (
    select f.followee_id as uid from follows f, me where f.follower_id = me.uid
  ),
  network as (
    select distinct f2.followee_id as uid
      from follows f1
      join follows f2 on f2.follower_id = f1.followee_id
      cross join me
     where f1.follower_id = me.uid
       and f2.followee_id <> me.uid
  ),
  reposts as (
    select distinct on (r.post_id) r.post_id, r.user_id
      from post_reposts r
      join following fo on fo.uid = r.user_id
     order by r.post_id, r.created_at desc
  ),
  popular as (
    select p.id
      from posts p
     where p.created_at > now() - interval '14 days'
       and (select count(*) from post_likes l where l.post_id = p.id)
         + 2 * (select count(*) from post_comments c where c.post_id = p.id)
         + 2 * (select count(*) from post_reposts r where r.post_id = p.id) >= 6
  ),
  scoped as (
    select p.id,
           p.created_at,
           case
             when p_handle is not null then 'profile'
             when p.author_id = me.uid then 'self'
             when p.author_id in (select uid from following) then 'following'
             when rp.post_id is not null then 'repost'
             when p.author_id in (select uid from network) then 'network'
             else 'popular'
           end as reason,
           case when p.author_id not in (select uid from following) then rp.user_id end as reposter_id
      from posts p
      cross join me
      left join reposts rp on rp.post_id = p.id
     where case
             when p_handle is not null then
               p.author_id = (select pr.user_id from profiles pr where pr.handle = lower(p_handle))
             else p.author_id = me.uid
                  or p.author_id in (select uid from following)
                  or rp.post_id is not null
                  or p.author_id in (select uid from network)
                  or p.id in (select popular.id from popular)
           end
       and (p_before is null
            or (p.created_at, p.id) < (p_before, coalesce(p_before_id, p.id)))
     order by p.created_at desc, p.id desc
     limit least(greatest(p_limit, 1), 50)
  )
  select pc.id, pc.body, pc.link_url, pc.image_path, pc.created_at, pc.edited_at,
         pc.author_id, pc.handle, pc.display_name, pc.avatar_color,
         pc.category, pc.visibility,
         pc.game_id, pc.game_title, pc.game_cover, pc.game_artwork,
         pc.game_year, pc.game_genres, pc.game_rating, pc.game_platforms,
         pc.poll, pc.like_count, pc.comment_count, pc.repost_count, pc.share_count,
         pc.liked_by_me, pc.reposted_by_me,
         rpr.handle, rpr.display_name,
         s.reason
    from scoped s
    join private.post_cards pc on pc.id = s.id
    left join profiles rpr on rpr.user_id = s.reposter_id
   order by s.created_at desc, s.id desc;
$$;

revoke all on function shelf_feed(int, timestamptz, uuid, text) from public, anon;
grant execute on function shelf_feed(int, timestamptz, uuid, text) to authenticated;

-- shelf_post(p_post_id) -- the same 30-column row shape, for exactly one id.
-- SECURITY INVOKER (the default, no `security definer` here): the view is already
-- invoker, so a post the caller cannot see under RLS returns zero rows rather than
-- needing its own visibility check re-derived here.
--
-- No ranking exists for a single lookup, so reposted_by_handle/reposted_by_name are
-- always null and reason is 'self' when the caller wrote the post, 'following' when
-- they follow the author, and 'popular' otherwise -- low stakes either way, `reason`
-- is typed in the app and read nowhere in it.
create function shelf_post(p_post_id uuid)
returns table (
  id                 uuid,
  body               text,
  link_url           text,
  image_path         text,
  created_at         timestamptz,
  edited_at          timestamptz,
  author_id          uuid,
  handle             text,
  display_name       text,
  avatar_color       text,
  category           text,
  visibility         text,
  game_id            uuid,
  game_title         text,
  game_cover         text,
  game_artwork       text,
  game_year          int,
  game_genres        text[],
  game_rating        numeric,
  game_platforms     text[],
  poll               jsonb,
  like_count         bigint,
  comment_count      bigint,
  repost_count       bigint,
  share_count        bigint,
  liked_by_me        boolean,
  reposted_by_me     boolean,
  reposted_by_handle text,
  reposted_by_name   text,
  reason             text
)
language sql
stable
set search_path = public
as $$
  select pc.id, pc.body, pc.link_url, pc.image_path, pc.created_at, pc.edited_at,
         pc.author_id, pc.handle, pc.display_name, pc.avatar_color,
         pc.category, pc.visibility,
         pc.game_id, pc.game_title, pc.game_cover, pc.game_artwork,
         pc.game_year, pc.game_genres, pc.game_rating, pc.game_platforms,
         pc.poll, pc.like_count, pc.comment_count, pc.repost_count, pc.share_count,
         pc.liked_by_me, pc.reposted_by_me,
         null::text, null::text,
         case
           when pc.author_id = (select auth.uid()) then 'self'
           when exists (select 1 from follows f
                         where f.follower_id = (select auth.uid()) and f.followee_id = pc.author_id)
             then 'following'
           else 'popular'
         end
    from private.post_cards pc
   where pc.id = p_post_id;
$$;

revoke all on function shelf_post(uuid) from public, anon;
grant execute on function shelf_post(uuid) to authenticated;
