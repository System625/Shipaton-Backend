-- Posts, likes, comments, reports, and the feed query behind the Friends tab.
--
-- The design (Figma "Friends", and FRIEND_POSTS in the app's LibraryScreen.tsx) is a
-- authored post: a person's own words, optionally a link and an image, with like,
-- comment and share. That is user-generated content, so this migration carries the
-- obligations that come with it rather than leaving them for later:
--
--   * every post and comment is deletable by its author,
--   * a post's author may delete comments on their own post,
--   * blocks are enforced in the policies, not the UI (see shelf_blocked_between),
--   * anything can be reported, and the report is stored.
--
-- App Store guideline 1.2 asks for exactly this set before a UGC app ships, and it is
-- much cheaper to have it in the schema from the first migration than to retrofit it
-- under a launch deadline.
--
-- WHAT IS NOT HERE: nothing derives a post from library activity. "Started/finished/
-- rated" events were considered and cut -- the design shows people writing sentences,
-- not a system narrating their shelf, and deriving events would have meant opening
-- library_entries to other users, which 20260908213000 deliberately does not do.

create table posts (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null references auth.users(id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 500),
  -- The design's example post carries a bare external link. It is stored verbatim and
  -- never fetched by the backend: no preview, no oEmbed, no unfurling. Resolving a URL
  -- a stranger typed, from inside our infrastructure, is an SSRF surface for nothing --
  -- share ingestion fetches oEmbed only for TikTok and YouTube, by allowlist.
  link_url   text check (link_url is null or link_url ~* '^https?://'),
  -- Optional attachment to a catalog game, so a post can carry a cover instead of the
  -- link block. Cheap, and it is what makes the feed worth reading in a games app.
  game_id    uuid references games(id),
  -- Object path inside the `post-images` storage bucket. Not a URL: the bucket may be
  -- re-pointed at a CDN later without rewriting every row.
  image_path text,
  created_at timestamptz not null default now(),
  edited_at  timestamptz
);

-- The feed's only ordering, and its keyset pagination key.
create index posts_created on posts (created_at desc, id desc);
create index posts_author_created on posts (author_id, created_at desc);
create index posts_game on posts (game_id) where game_id is not null;

create table post_likes (
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)   -- liking twice is a no-op, not a second like
);

create table post_comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references posts(id) on delete cascade,
  author_id  uuid not null references auth.users(id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 300),
  created_at timestamptz not null default now()
);

create index post_comments_post on post_comments (post_id, created_at);
create index post_comments_author on post_comments (author_id);

create table content_reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('post','comment','profile')),
  target_id   uuid not null,
  reason      text not null check (length(btrim(reason)) between 1 and 300),
  created_at  timestamptz not null default now()
);

create index content_reports_target on content_reports (target_type, target_id);

alter table posts           enable row level security;
alter table post_likes      enable row level security;
alter table post_comments   enable row level security;
alter table content_reports enable row level security;

-- Posts are readable by any signed-in account, not only followers: the design lets you
-- open a profile before you follow it, and a feed you cannot preview is a feed nobody
-- follows. Blocks are the one thing that removes them from view, in both directions.
create policy "posts readable unless blocked"
  on posts for select to authenticated
  using (not shelf_blocked_between((select auth.uid()), author_id));
create policy "own posts insert"
  on posts for insert to authenticated
  with check (author_id = (select auth.uid()));
create policy "own posts update"
  on posts for update to authenticated
  using (author_id = (select auth.uid()))
  with check (author_id = (select auth.uid()));
create policy "own posts delete"
  on posts for delete to authenticated
  using (author_id = (select auth.uid()));

create policy "likes readable by authenticated"
  on post_likes for select to authenticated using (true);
create policy "own likes insert"
  on post_likes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own likes delete"
  on post_likes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy "comments readable unless blocked"
  on post_comments for select to authenticated
  using (not shelf_blocked_between((select auth.uid()), author_id));
create policy "own comments insert"
  on post_comments for insert to authenticated
  with check (
    author_id = (select auth.uid())
    and exists (select 1 from posts p
                 where p.id = post_id
                   and not shelf_blocked_between((select auth.uid()), p.author_id))
  );
-- Either the person who wrote the comment, or the person whose post it sits under.
-- The second half is the moderation tool: you can always clear your own post.
create policy "comment deletable by author or post owner"
  on post_comments for delete to authenticated
  using (
    author_id = (select auth.uid())
    or exists (select 1 from posts p
                where p.id = post_id and p.author_id = (select auth.uid()))
  );

create policy "own reports insert"
  on content_reports for insert to authenticated
  with check (reporter_id = (select auth.uid()));
create policy "own reports readable"
  on content_reports for select to authenticated
  using (reporter_id = (select auth.uid()));

-- Post images. Public-read so a cover or screenshot renders without a signed URL round
-- trip on every card; writes are confined to a folder named after the uploader's uid,
-- which is what stops one account overwriting another's image.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', true, 5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

create policy "post images readable"
  on storage.objects for select to authenticated
  using (bucket_id = 'post-images');
create policy "post images written to own folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'post-images'
              and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "post images deletable by owner"
  on storage.objects for delete to authenticated
  using (bucket_id = 'post-images'
         and (storage.foldername(name))[1] = (select auth.uid())::text);

-- The feed, in one round trip.
--
-- Two uses, one function: with p_handle null it is the Friends tab (people you follow,
-- plus yourself, so your own post appears the moment you write it); with a handle it is
-- that person's profile feed. Keyset pagination on (created_at, id) rather than OFFSET,
-- because a feed people post into shifts under an offset and duplicates rows.
--
-- Counts are subqueries rather than joins with group by: at one row per card and an
-- index on each foreign key they are index-only lookups, and they keep `liked_by_me`
-- honest per viewer instead of leaking someone else's like into the aggregate.
create or replace function shelf_feed(
  p_limit     int         default 20,
  p_before    timestamptz default null,
  p_before_id uuid        default null,
  p_handle    text        default null
)
returns table (
  id            uuid,
  body          text,
  link_url      text,
  image_path    text,
  created_at    timestamptz,
  edited_at     timestamptz,
  author_id     uuid,
  handle        text,
  display_name  text,
  avatar_color  text,
  game_id       uuid,
  game_title    text,
  game_cover    text,
  like_count    bigint,
  comment_count bigint,
  liked_by_me   boolean
)
language sql
stable
set search_path = public
as $$
  select p.id, p.body, p.link_url, p.image_path, p.created_at, p.edited_at,
         p.author_id, pr.handle, pr.display_name, pr.avatar_color,
         g.id, g.title, g.cover_url,
         (select count(*) from post_likes l where l.post_id = p.id),
         (select count(*) from post_comments c where c.post_id = p.id),
         exists (select 1 from post_likes l
                  where l.post_id = p.id and l.user_id = (select auth.uid()))
    from posts p
    join profiles pr on pr.user_id = p.author_id
    left join games g on g.id = p.game_id
   where case
           when p_handle is not null then pr.handle = lower(p_handle)
           else p.author_id = (select auth.uid())
                or exists (select 1 from follows f
                            where f.follower_id = (select auth.uid())
                              and f.followee_id = p.author_id)
         end
     and (p_before is null
          or (p.created_at, p.id) < (p_before, coalesce(p_before_id, p.id)))
   order by p.created_at desc, p.id desc
   limit least(greatest(p_limit, 1), 50);
$$;

-- Follower/following/post counts for a profile header, in one call.
create or replace function shelf_profile_stats(p_handle text)
returns table (
  user_id     uuid,
  handle      text,
  display_name text,
  avatar_color text,
  bio          text,
  followers    bigint,
  following    bigint,
  post_count   bigint,
  followed_by_me boolean,
  is_me        boolean
)
language sql
stable
set search_path = public
as $$
  select pr.user_id, pr.handle, pr.display_name, pr.avatar_color, pr.bio,
         (select count(*) from follows f where f.followee_id = pr.user_id),
         (select count(*) from follows f where f.follower_id = pr.user_id),
         (select count(*) from posts p where p.author_id = pr.user_id),
         exists (select 1 from follows f
                  where f.follower_id = (select auth.uid())
                    and f.followee_id = pr.user_id),
         pr.user_id = (select auth.uid())
    from profiles pr
   where pr.handle = lower(p_handle);
$$;

-- Migration 000700's rule, once per function.
revoke all on function shelf_feed(int, timestamptz, uuid, text) from public, anon;
revoke all on function shelf_profile_stats(text)                from public, anon;
grant execute on function shelf_feed(int, timestamptz, uuid, text) to authenticated;
grant execute on function shelf_profile_stats(text)                to authenticated;
