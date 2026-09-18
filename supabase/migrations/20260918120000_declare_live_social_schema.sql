-- Declares six objects that already exist on the live project
-- (sbunhrxwhraigwpidbxk) and appear in NO migration in this repo: games.artwork_url,
-- posts.category, the tables post_polls / post_poll_options / post_poll_votes /
-- post_reposts / post_shares, and a shelf_feed that returns eleven more columns
-- than 20260908213500_social_feed.sql defines -- plus the three functions
-- (shelf_poll, shelf_create_post, shelf_vote_poll) that run the poll feature and
-- exist nowhere in this repo either. Nobody has said who applied them or when;
-- that is still worth asking. docs/STATUS.md § "PICK UP HERE" #3,
-- [[shelf-live-schema-ahead-of-migrations]].
--
-- Two ways the gap bites, and the second is silent:
--   * `npm run db:reset` produces a database the live app cannot use -- no polls,
--     no reposts, no shares, no post categories, no artwork.
--   * A `create or replace function shelf_feed(...)` written from this repo's
--     93-line copy would DELETE the eleven columns the app already reads, with
--     no error on either side. Same failure shape as the six-wider shelf_feed
--     this migration exists to stop.
--
-- Every statement below is written to run cleanly against the LIVE database,
-- where these objects already exist, as well as a `db:reset` build starting from
-- zero -- `if not exists` / `create or replace` throughout, `drop policy if
-- exists` before each `create policy` (Postgres has no `create policy if not
-- exists`). Definitions are copied from the live `pg_proc` / `information_schema`,
-- not re-derived, so this migration changes nothing about how the app behaves.
--
-- ONE THING FIXED WHILE DECLARING IT, not a behaviour change: shelf_poll,
-- shelf_create_post and shelf_vote_poll were never revoked from PUBLIC/anon --
-- `select proacl from pg_proc where proname = 'shelf_create_post'` showed
-- `anon=X`, meaning an unauthenticated request could call it. Every other
-- shelf_% function in this project revokes public/anon and grants only
-- `authenticated` (the rule from migration 000700, restated in every migration
-- that touches a function). These three are plpgsql/sql functions that read
-- `auth.uid()` and do nothing useful for an anonymous caller, so closing the grant
-- changes no real behaviour and removes three functions that could run against
-- an unauthenticated JWT.

-- ---------------------------------------------------------------------------
-- 1. games.artwork_url -- the wide/landscape image shelf_feed puts behind a
--    post's game card. 46 of 91,815 rows are filled: exactly the games that have
--    appeared in a `posts` row, so whatever wrote this backfills on demand rather
--    than seeding it for the whole catalog. No index, no constraint, no comment
--    on the live column -- reproduced as-is.
-- ---------------------------------------------------------------------------
alter table games add column if not exists artwork_url text;

comment on column games.artwork_url is
  'Wide/landscape art shelf_feed nests inside a post''s game card. Populated on '
  'demand -- 46 of 91,815 rows, exactly the games that have appeared in a post --  '
  'not seeded for the whole catalog. Not the same asset as cover_url (portrait) or '
  'the screenshots discussed in docs/research/quick-view-card.md.';

-- ---------------------------------------------------------------------------
-- 2. posts.category -- trophies / questions / memes, an optional tag on a post.
--    Nullable; the app's existing "authored post" flow needs none of the three.
-- ---------------------------------------------------------------------------
alter table posts add column if not exists category text;

do $$
begin
  alter table posts
    add constraint posts_category_check
    check (category is null or category = any (array['trophies', 'questions', 'memes']));
exception
  when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Polls. One-per-post (post_polls), 2-4 labelled options (post_poll_options),
--    one vote per user that can change while the poll is open (post_poll_votes).
-- ---------------------------------------------------------------------------
create table if not exists post_polls (
  post_id    uuid primary key references posts(id) on delete cascade,
  ends_at    timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists post_poll_options (
  id       uuid not null default gen_random_uuid(),
  post_id  uuid not null references post_polls(post_id) on delete cascade,
  position smallint not null check (position >= 0 and position <= 3),
  label    text not null check (length(btrim(label)) between 1 and 40),
  primary key (id),
  -- Both unique constraints exist live: (post_id, position) stops two options
  -- sharing a slot, and (post_id, id) is what lets post_poll_votes' composite FK
  -- below prove an option belongs to the post it is voted on through.
  unique (post_id, position),
  unique (post_id, id)
);

create table if not exists post_poll_votes (
  post_id    uuid not null references post_polls(post_id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  option_id  uuid not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id),
  -- Proves option_id actually belongs to post_id -- a plain FK to
  -- post_poll_options(id) alone would let a vote name an option from a DIFFERENT
  -- poll and still pass.
  foreign key (post_id, option_id) references post_poll_options (post_id, id) on delete cascade
);

create index if not exists post_poll_votes_option on post_poll_votes (option_id);
create index if not exists post_poll_votes_user   on post_poll_votes (user_id);

alter table post_polls       enable row level security;
alter table post_poll_options enable row level security;
alter table post_poll_votes  enable row level security;

drop policy if exists "polls readable with their post" on post_polls;
create policy "polls readable with their post"
  on post_polls for select to authenticated
  using (exists (select 1 from posts p where p.id = post_polls.post_id));

drop policy if exists "own polls insert" on post_polls;
create policy "own polls insert"
  on post_polls for insert to authenticated
  with check (exists (select 1 from posts p
                        where p.id = post_polls.post_id and p.author_id = (select auth.uid())));

drop policy if exists "poll options readable with their post" on post_poll_options;
create policy "poll options readable with their post"
  on post_poll_options for select to authenticated
  using (exists (select 1 from posts p where p.id = post_poll_options.post_id));

drop policy if exists "own poll options insert" on post_poll_options;
create policy "own poll options insert"
  on post_poll_options for insert to authenticated
  with check (exists (select 1 from posts p
                        where p.id = post_poll_options.post_id and p.author_id = (select auth.uid())));

drop policy if exists "poll votes readable with their post" on post_poll_votes;
create policy "poll votes readable with their post"
  on post_poll_votes for select to authenticated
  using (
    exists (select 1 from posts p where p.id = post_poll_votes.post_id)
    and not private.shelf_blocked_between((select auth.uid()), user_id)
  );

-- Voting after ends_at is blocked in the policy, not just left to the app --
-- shelf_vote_poll (below) is SQL run as the caller, not DEFINER, so this is the
-- only enforcement there is.
drop policy if exists "own poll votes insert while open" on post_poll_votes;
create policy "own poll votes insert while open"
  on post_poll_votes for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from post_polls pp
                 where pp.post_id = post_poll_votes.post_id and pp.ends_at > now())
  );

drop policy if exists "own poll votes update while open" on post_poll_votes;
create policy "own poll votes update while open"
  on post_poll_votes for update to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from post_polls pp
                 where pp.post_id = post_poll_votes.post_id and pp.ends_at > now())
  );

drop policy if exists "own poll votes delete" on post_poll_votes;
create policy "own poll votes delete"
  on post_poll_votes for delete to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Reposts and shares. Both are direct-PostgREST tables, same shape as
--    post_likes -- no RPC exists to write either one, which is why neither shows
--    up beside shelf_create_post/shelf_vote_poll above.
-- ---------------------------------------------------------------------------
create table if not exists post_reposts (
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create index if not exists post_reposts_user on post_reposts (user_id, created_at desc);

alter table post_reposts enable row level security;

drop policy if exists "reposts readable with their post" on post_reposts;
create policy "reposts readable with their post"
  on post_reposts for select to authenticated
  using (
    exists (select 1 from posts p where p.id = post_reposts.post_id)
    and not private.shelf_blocked_between((select auth.uid()), user_id)
  );

drop policy if exists "own reposts insert" on post_reposts;
create policy "own reposts insert"
  on post_reposts for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from posts p where p.id = post_reposts.post_id)
  );

drop policy if exists "own reposts delete" on post_reposts;
create policy "own reposts delete"
  on post_reposts for delete to authenticated
  using (user_id = (select auth.uid()));

-- post_shares has no delete policy, live -- a share is a fact ("this person shared
-- this post"), not a toggle like a like or a repost, so nothing removes a row once
-- written. Reproduced as-is.
create table if not exists post_shares (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references posts(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists post_shares_post on post_shares (post_id);

alter table post_shares enable row level security;

drop policy if exists "share rows readable with their post" on post_shares;
create policy "share rows readable with their post"
  on post_shares for select to authenticated
  using (exists (select 1 from posts p where p.id = post_shares.post_id));

drop policy if exists "own shares insert" on post_shares;
create policy "own shares insert"
  on post_shares for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from posts p where p.id = post_shares.post_id)
  );

-- ---------------------------------------------------------------------------
-- 5. The three poll functions. Bodies copied verbatim from live pg_proc.
-- ---------------------------------------------------------------------------

-- Assembles one post's poll -- options, vote counts, the caller's own pick, and up
-- to 3 avatars per option (self first, then people the caller follows, then most
-- recent) -- into the single jsonb `poll` column shelf_feed nests it under. Returns
-- null, not an error, for a post that carries no poll, so callers can `left join`
-- this the same way shelf_feed does rather than branching on existence first.
create or replace function shelf_poll(p_post_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select case when pp.post_id is null then null else jsonb_build_object(
    'ends_at', pp.ends_at,
    'total_votes', (select count(*) from post_poll_votes v where v.post_id = pp.post_id),
    'my_option_id', (select v.option_id from post_poll_votes v
                      where v.post_id = pp.post_id and v.user_id = (select auth.uid())),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id,
               'label', o.label,
               'votes', (select count(*) from post_poll_votes v where v.option_id = o.id),
               'voters', coalesce((
                 select jsonb_agg(jsonb_build_object('handle', x.handle, 'avatar_color', x.avatar_color))
                   from (
                     select pr.handle, pr.avatar_color
                       from post_poll_votes v
                       join profiles pr on pr.user_id = v.user_id
                      where v.option_id = o.id
                      order by (v.user_id = (select auth.uid())) desc,
                               exists (select 1 from follows f
                                        where f.follower_id = (select auth.uid())
                                          and f.followee_id = v.user_id) desc,
                               v.created_at desc
                      limit 3
                   ) x), '[]'::jsonb)
             ) order by o.position)
        from post_poll_options o
       where o.post_id = pp.post_id), '[]'::jsonb)
  ) end
    from (select p_post_id as id) q
    left join post_polls pp on pp.post_id = q.id;
$$;

-- One call for "write a post," poll included. Plain insert into posts, and -- only
-- when p_poll_options is given -- the matching post_polls/post_poll_options rows in
-- the same statement, so a post with a broken poll (created, options half-written)
-- cannot exist: either both inserts happen or the function raises before either
-- commits. 1 option is rejected the same as 5 -- a poll needs a real choice.
create or replace function shelf_create_post(
  p_body         text,
  p_category     text    default null,
  p_game_id      uuid    default null,
  p_image_path   text    default null,
  p_link_url     text    default null,
  p_poll_options text[]  default null,
  p_poll_hours   int     default 24
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

  insert into posts (author_id, body, category, game_id, image_path, link_url)
  values ((select auth.uid()), btrim(p_body), p_category, p_game_id, p_image_path, p_link_url)
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

-- Upsert-by-(post_id, user_id): voting again changes the pick rather than adding a
-- second row, which is also the only reason this needs to be a function rather than
-- a plain PostgREST insert -- an `on conflict do update` has no REST equivalent.
-- The open-poll check lives in the two RLS policies above, not here; returns the
-- freshly recomputed shelf_poll() so the caller can repaint without a second
-- round trip.
create or replace function shelf_vote_poll(p_post_id uuid, p_option_id uuid)
returns jsonb
language plpgsql
set search_path = public
as $$
begin
  insert into post_poll_votes (post_id, user_id, option_id)
  values (p_post_id, (select auth.uid()), p_option_id)
  on conflict (post_id, user_id) do update
    set option_id = excluded.option_id, created_at = now();
  return shelf_poll(p_post_id);
end;
$$;

revoke all on function shelf_poll(uuid)        from public, anon;
revoke all on function shelf_create_post(text, text, uuid, text, text, text[], int) from public, anon;
revoke all on function shelf_vote_poll(uuid, uuid) from public, anon;
grant execute on function shelf_poll(uuid)        to authenticated;
grant execute on function shelf_create_post(text, text, uuid, text, text, text[], int) to authenticated;
grant execute on function shelf_vote_poll(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. shelf_feed itself. Copied verbatim from live pg_proc, which has grown past
--    20260908213500's 16-column version to 28: category is now selected through
--    (`s.category` was never in the repo's copy), game_artwork/year/genres/
--    rating/platforms, poll (shelf_poll above), repost_count, share_count,
--    liked_by_me/reposted_by_me, reposted_by_handle/name, and `reason` --
--    plus a whole ranking tier the repo's version never had: a `network`
--    CTE (friends-of-friends) and a `popular` CTE (posts trending in the last
--    14 days) that both backfill the feed once "people you follow" runs out, and
--    a `reason` column the app can use to label why each card is there
--    ('self' | 'following' | 'repost' | 'network' | 'popular' | 'profile').
--    Same input signature as 20260908213500's version, so this is a pure
--    `create or replace`, not a drop+create.
-- ---------------------------------------------------------------------------
create or replace function shelf_feed(
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
  -- The latest repost of each post by someone the caller follows.
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
    select p.*,
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
  select s.id, s.body, s.link_url, s.image_path, s.created_at, s.edited_at,
         s.author_id, pr.handle, pr.display_name, pr.avatar_color,
         s.category,
         g.id, g.title, g.cover_url, g.artwork_url,
         extract(year from g.release_date)::integer,
         g.genres,
         case when g.critic_score is null then null else round(g.critic_score / 20.0, 1) end,
         (select array_agg(distinct pl.family)
            from game_platforms gp join platforms pl on pl.id = gp.platform_id
           where gp.game_id = g.id and pl.family is not null),
         shelf_poll(s.id),
         (select count(*) from post_likes l where l.post_id = s.id),
         (select count(*) from post_comments c where c.post_id = s.id),
         (select count(*) from post_reposts r where r.post_id = s.id),
         (select count(*) from post_shares sh where sh.post_id = s.id),
         exists (select 1 from post_likes l where l.post_id = s.id and l.user_id = (select auth.uid())),
         exists (select 1 from post_reposts r where r.post_id = s.id and r.user_id = (select auth.uid())),
         rpr.handle, rpr.display_name,
         s.reason
    from scoped s
    join profiles pr on pr.user_id = s.author_id
    left join games g on g.id = s.game_id
    left join profiles rpr on rpr.user_id = s.reposter_id
   order by s.created_at desc, s.id desc;
$$;

revoke all on function shelf_feed(int, timestamptz, uuid, text) from public, anon;
grant execute on function shelf_feed(int, timestamptz, uuid, text) to authenticated;
