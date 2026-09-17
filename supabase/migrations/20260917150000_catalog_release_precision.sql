-- Carries games.release_precision (20260917100000) out to the app.
--
-- The column shipped and the backfill ran, but nothing returned it: not
-- shelf_catalog_row, not the five functions built on it, not /games/:id's column
-- list. docs/technical-notes-for-sola.md told Sola "every CatalogGame's
-- release_date now sits next to releasePrecision -- only trust a release date as
-- day-accurate if releasePrecision === 'day'", which the app could not do. Both
-- stated reasons for the column -- an honest "Upcoming" filter, and stopping the
-- app's on-device reminders firing on IGDB's 31-Dec placeholders -- live in the
-- app, so a column it cannot read fixes neither. 83.5% of the 3,748 upcoming
-- releases are not day-precise; until this migration the app had no way to know
-- which.
--
-- WHY IT LANDS LAST IN THE ROW rather than next to release_date, where it
-- belongs: `alter type ... add attribute` appends, and every function returning
-- shelf_catalog_row must select its columns in attribute order. Reordering means
-- dropping the composite type, which means dropping all three functions that
-- return it and re-granting each. PostgREST serialises by name, so position is
-- cosmetic -- not worth that. Add new catalog columns the same way.

alter type shelf_catalog_row add attribute release_precision text;

-- ---------------------------------------------------------------------------
-- The three SETOF shelf_catalog_row functions. Bodies are unchanged except for
-- the trailing `g.release_precision`; a `create or replace` whose select list
-- still returns 12 columns would fail against the 13-attribute type, which is
-- exactly why all three are here in one migration with the alter above.
-- ---------------------------------------------------------------------------

create or replace function shelf_popular_games(max_results int default 20, p_offset int default 0)
returns setof shelf_catalog_row
language sql
stable
set search_path = public, extensions
as $$
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         null::real,
         g.release_precision
    from games g
   where g.total_rating_count > 0
   order by g.total_rating_count desc, g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

create or replace function shelf_roulette(
  p_user_id       uuid,
  p_platform_id   int,
  p_size_bucket   text    default null,
  p_session_hours numeric default 2
)
returns setof shelf_catalog_row
language sql
stable
set search_path = public, extensions
as $$
  with urgency as (
    select greatest(0.0, least(1.0, (4.0 - p_session_hours) / 3.5))::double precision as u
  )
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp2 join platforms p on p.id = gp2.platform_id
             where gp2.game_id = g.id),
           '[]'::jsonb),
         null::real,
         g.release_precision
    from library_entries le
    join games g           on g.id = le.game_id
    join game_platforms gp on gp.game_id = g.id
   cross join urgency
   -- RLS on library_entries already scopes this to the caller. The auth.uid()
   -- check makes it a hole-free function in its own right rather than one that
   -- depends on a policy staying in place.
   where le.user_id = p_user_id
     and p_user_id = (select auth.uid())
     and le.status in ('backlog','playing')
     and gp.platform_id = p_platform_id
     -- size is the ONLY filter. hours must never appear in a where clause.
     and (p_size_bucket is null or
          case p_size_bucket
            when 'quick'  then coalesce(g.ttb_normally_hours, 15) <  10
            when 'medium' then coalesce(g.ttb_normally_hours, 15) between 10 and 30
            when 'epic'   then coalesce(g.ttb_normally_hours, 15) >  30
            else true
          end)
   order by
     power(
       random(),
       1.0 / (
         1.0
         + urgency.u * 2.0 * (case when le.status = 'playing' then 1 else 0 end)
         + urgency.u * 1.0 * (case g.session_fit when 'high' then 2 when 'medium' then 1 else 0 end)
       )
     ) desc
   limit 1;
$$;

create or replace function shelf_search_games(
  q             text,
  max_results   int    default 5,
  release_from  date   default null,
  release_to    date   default null,
  pills         text[] default null,
  device_types  text[] default null,
  sort_by       text   default 'best_match',
  sort_dir      text   default 'desc'
)
returns setof shelf_catalog_row
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  needle   text := shelf_match_title(q);
  squashed text := replace(shelf_match_title(q), ' ', '');
  toks     text[];
  ntok     int;
  genres_wanted text[];
  recent_cap    date := null;
  asc_order     boolean := (lower(coalesce(sort_dir, 'desc')) = 'asc');
  sort_mode     text    := lower(coalesce(sort_by, 'best_match'));
begin
  if needle = '' then
    return;
  end if;

  -- Distinct, because `having count(distinct tok) = ntok` can never be satisfied
  -- if the needle repeats a word and ntok counts it twice.
  select array_agg(distinct t) into toks
    from unnest(string_to_array(needle, ' ')) as t
   where t <> '';
  ntok := coalesce(array_length(toks, 1), 0);

  -- The gate. An empty array makes arm 5 scan nothing rather than everything.
  if ntok < 2 then
    toks := '{}'::text[];
    ntok := 0;
  end if;

  -- Pills resolve to IGDB genre names up front. A pill nobody maps contributes
  -- nothing, so a selection of only unmapped pills yields an empty array and the
  -- filter below matches no row -- see the note on genre_pills above.
  -- The parameter is `pills`, not `genre_pills`: a plpgsql variable shares a
  -- namespace with the query's identifiers, so a parameter named after the table
  -- it reads makes `from genre_pills` ambiguous.
  if pills is not null and cardinality(pills) > 0 then
    select coalesce(array_agg(distinct gp.genre), '{}'::text[]) into genres_wanted
      from genre_pills gp
     where gp.pill = any(pills);
  end if;

  -- MOST RECENT MUST NOT OPEN ON UNRELEASED GAMES. 3,668 catalog rows carry a
  -- future date; sorted by date descending they would fill the whole first page
  -- ahead of everything that has actually shipped, which is not what "Most
  -- Recent" means to anyone. So when the caller sorts by date and has set no
  -- release window at all, cap at today. If they set any window -- including the
  -- Upcoming bucket, which is `release_from = tomorrow` -- respect it exactly and
  -- do not cap. Flagged to Paul as a judgement call, not a settled decision.
  if sort_mode = 'recent' and release_from is null and release_to is null then
    recent_cap := current_date;
  end if;

  return query
  with hits as (
    select g.id, similarity(g.match_title, needle) as score
      from games g
     where g.match_title % needle
    union all
    select a.game_id, similarity(a.match_title, needle) * 0.98
      from game_alt_titles a
     where a.match_title % needle
    union all
    -- Arms 3 and 4: the needle IS the name, bar the spaces. Btree probes.
    select g.id, 1.0::real
      from games g
     where squashed <> ''
       and replace(g.match_title, ' ', '') = squashed
    union all
    select a.game_id, 0.98::real
      from game_alt_titles a
     where squashed <> ''
       and replace(a.match_title, ' ', '') = squashed
    union all
    -- Arm 5: every token of the query accounted for by this game's names.
    select x.game_id, 0.60::real
      from (
        select g.id as game_id, t.tok
          from unnest(toks) as t(tok)
          join games g
            on to_tsvector('simple', g.match_title) @@ plainto_tsquery('simple', t.tok)
        union all
        select a.game_id, t.tok
          from unnest(toks) as t(tok)
          join game_alt_titles a
            on to_tsvector('simple', a.match_title) @@ plainto_tsquery('simple', t.tok)
      ) x
     group by x.game_id
    having count(distinct x.tok) = ntok
  ),
  best as (
    select h.id, max(h.score) as score from hits h group by h.id
  )
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         b.score::real,
         g.release_precision
    from best b
    join games g on g.id = b.id
   -- Filters sit here, BEFORE the limit. Applied after it -- which is what
   -- filtering in the app amounts to -- a 10-row page comes back near-empty.
   where (release_from is null or g.release_date >= release_from)
     and (release_to   is null or g.release_date <= release_to)
     and (recent_cap   is null or g.release_date <= recent_cap)
     -- Undated rows drop out here for free: every comparison above is NULL for
     -- them, and NULL is not true. No explicit `release_date is not null` needed.
     and (genres_wanted is null or g.genres && genres_wanted)
     and (device_types is null or cardinality(device_types) = 0 or exists (
           select 1 from game_platforms gp
             join platforms p on p.id = gp.platform_id
            where gp.game_id = g.id
              and p.family = any(device_types)))
   order by
     -- best_match is the existing ranking, unchanged and still the default, so an
     -- unfiltered unsorted call returns exactly what it returned before.
     case when sort_mode = 'best_match' then
       b.score + 0.15 * ln(1 + coalesce(g.total_rating_count, 0)) / ln(1 + 10000)
     end desc,
     case when sort_mode = 'best_match' then g.critic_score end desc nulls last,
     -- Most Popular takes no direction (design, p5: "Most Popular does not need
     -- an order for example").
     case when sort_mode = 'popular' then coalesce(g.total_rating_count, 0) end desc,
     -- Ratings is thin: critic_score is present on 8,952 of 89,123 rows (10.0%),
     -- so nulls last is doing most of the work and rating count breaks the tie.
     -- Flagged to Paul.
     case when sort_mode = 'rating' and not asc_order then g.critic_score end desc nulls last,
     case when sort_mode = 'rating' and     asc_order then g.critic_score end asc  nulls last,
     case when sort_mode = 'rating' then coalesce(g.total_rating_count, 0) end desc,
     case when sort_mode = 'recent' and not asc_order then g.release_date end desc nulls last,
     case when sort_mode = 'recent' and     asc_order then g.release_date end asc  nulls last,
     case when sort_mode = 'alpha'  and not asc_order then g.title end desc,
     case when sort_mode = 'alpha'  and     asc_order then g.title end asc,
     -- Every sort ends on a stable tiebreak, or equal rows shuffle between pages.
     g.id
   limit greatest(max_results, 1);
end;
$$;

-- ---------------------------------------------------------------------------
-- The two functions that inline the same shape instead of returning the type.
-- Their return type changes, so they drop rather than replace (same rule as
-- 20260914130100 and 20260917130000). Bodies are otherwise untouched.
-- ---------------------------------------------------------------------------

drop function if exists shelf_recently_viewed(int, int);

create function shelf_recently_viewed(max_results int default 20, p_offset int default 0)
returns table (
  id                 uuid,
  title              text,
  slug               text,
  release_date       date,
  genres             text[],
  cover_url          text,
  critic_score       smallint,
  ttb_normally_hours numeric,
  ttb_count          int,
  session_fit        text,
  platforms          jsonb,
  score              real,
  release_precision  text,
  viewed_at          timestamptz
)
language sql
stable
set search_path = public, extensions
as $$
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         null::real,
         g.release_precision,
         rv.viewed_at
    from recently_viewed rv
    join games g on g.id = rv.game_id
   -- SECURITY INVOKER, so RLS already scopes this to the caller. The predicate is
   -- here anyway because it is what lets the planner use recently_viewed_user_recent
   -- for the sort; leaving it to the policy alone works but scans more.
   where rv.user_id = (select auth.uid())
   order by rv.viewed_at desc, g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

drop function if exists shelf_popular_with_friends(int, int);

create function shelf_popular_with_friends(max_results int default 20, p_offset int default 0)
returns table (
  id                 uuid,
  title              text,
  slug               text,
  release_date       date,
  genres             text[],
  cover_url          text,
  critic_score       smallint,
  ttb_normally_hours numeric,
  ttb_count          int,
  session_fit        text,
  platforms          jsonb,
  score              real,
  release_precision  text,
  friend_count       bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with viewer as (
    select (select auth.uid()) as uid
  ),
  -- Who counts: people the viewer follows, who opted in, who are not blocked in
  -- either direction. The block check is inlined rather than calling
  -- private.shelf_blocked_between per row -- this function is already DEFINER and so
  -- already reads every block row, and inlining lets the planner use
  -- user_blocks' primary key instead of a function call per followee. Nothing about
  -- blocks reaches the result either way; they only remove rows.
  --
  -- The self-exclusion is redundant against the no_self_follow constraint and kept
  -- anyway: the whole point is what OTHER people play, and a silent change to that
  -- constraint should not quietly fold the viewer's own shelf into the counts.
  friends as (
    select f.followee_id as uid
      from follows f
      cross join viewer v
     where f.follower_id = v.uid
       and f.followee_id <> v.uid
       and exists (select 1 from profiles pr
                    where pr.user_id = f.followee_id
                      and pr.share_activity)
       and not exists (select 1 from user_blocks b
                        where (b.blocker_id = v.uid and b.blocked_id = f.followee_id)
                           or (b.blocker_id = f.followee_id and b.blocked_id = v.uid))
  ),
  -- 'playing' and 'beaten' only. 'dropped' is a negative signal and would be actively
  -- misleading in a list headed "popular"; 'backlog' means "intend to", which is a
  -- wishlist in all but name and a much weaker claim than the feature makes. Change
  -- the IN list if that call turns out wrong -- it is the only thing that decides it.
  --
  -- The owner floor is a LITERAL, not a parameter, and must stay one: a caller who
  -- could pass 1 would have a function that reads a single followee's shelf back
  -- verbatim, which is the exact attack the floor exists to price up.
  counted as (
    select le.game_id, count(distinct le.user_id) as friend_count
      from library_entries le
      join friends fr on fr.uid = le.user_id
     where le.status in ('playing', 'beaten')
     group by le.game_id
    having count(distinct le.user_id) >= 3
  )
  select g.id, g.title, g.slug, g.release_date, g.genres, g.cover_url,
         g.critic_score, g.ttb_normally_hours, g.ttb_count, g.session_fit,
         coalesce(
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'slug', p.slug)
                             order by p.name)
              from game_platforms gp join platforms p on p.id = gp.platform_id
             where gp.game_id = g.id),
           '[]'::jsonb),
         -- NULL for the same reason shelf_popular_games returns NULL here: `score` is
         -- a similarity score everywhere else, and putting a different quantity in it
         -- is a trap for the next caller. The count has its own column.
         null::real,
         g.release_precision,
         c.friend_count
    from counted c
    join games g on g.id = c.game_id
    -- The trailing id is not decoration. Ties on friend_count will be the common case
    -- at small follower counts, and without a unique final key offset pagination drops
    -- and repeats rows between pages -- the lesson from shelf_popular_games.
   order by c.friend_count desc, coalesce(g.total_rating_count, 0) desc, g.id
   limit  greatest(max_results, 1)
  offset  greatest(p_offset, 0);
$$;

-- ---------------------------------------------------------------------------
-- Grants. Migration 000700's rule, and it bites every time a function is created
-- OR replaced: `create or replace` restores the default PUBLIC execute grant and
-- Supabase's default privileges add an explicit anon grant, so both have to go on
-- every one of the five -- including the three that only changed a select list.
-- Check with: select proname, proacl from pg_proc where proname like 'shelf_%';
-- ---------------------------------------------------------------------------
revoke all on function shelf_popular_games(int, int)        from public, anon;
revoke all on function shelf_roulette(uuid, int, text, numeric) from public, anon;
revoke all on function shelf_search_games(text, int, date, date, text[], text[], text, text)
  from public, anon;
revoke all on function shelf_recently_viewed(int, int)      from public, anon;
revoke all on function shelf_popular_with_friends(int, int) from public, anon;

grant execute on function shelf_popular_games(int, int)        to authenticated;
grant execute on function shelf_roulette(uuid, int, text, numeric) to authenticated;
grant execute on function shelf_search_games(text, int, date, date, text[], text[], text, text)
  to authenticated;
grant execute on function shelf_recently_viewed(int, int)      to authenticated;
grant execute on function shelf_popular_with_friends(int, int) to authenticated;
