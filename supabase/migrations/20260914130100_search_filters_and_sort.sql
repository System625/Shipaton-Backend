-- The search-screen filter header: Release Date pill, Categories pill (genre +
-- device type) and the Sort By portal. Design: "Prysm - Search", Paul Elite,
-- 9 Sep 2026, pages 3-5, plus his Release Date bucket sheet of 11 Sep.
--
-- WHY THIS IS BACKEND AT ALL. `/search` asks for 10 rows. Filtering those 10 in
-- the app gives a near-empty list and reads as broken, so the filter has to go
-- into the query, before the limit. Same argument settled the Release Date pill
-- on 12 Sep and Paul confirmed the placement: the pill is the one from the search
-- doc, not a shelf filter.

-- ---------------------------------------------------------------------------
-- 1. Release date
-- ---------------------------------------------------------------------------
-- TWO DATES, NOT `era=2020s`. Paul's sheet names buckets (2020s, 2010s, ...,
-- Earlier, Upcoming) and his own "2020s / 2020-2026" label is already dated. If
-- the bucket names live in the API, every boundary he moves is a migration. The
-- app owns the labels, the ranges and the Save Changes persistence; this owns two
-- dates and an index.
--
-- Both bounds are inclusive. `release_from = null` means unbounded below,
-- `release_to = null` unbounded above. "Upcoming" is `release_from = tomorrow`.
--
-- UNDATED GAMES ARE NEVER RETURNED BY A DATE FILTER, including "Upcoming", and
-- that is now the settled product answer rather than a limitation. A game IGDB
-- lists with no date is in neither seed pass (deliberate, documented in igdb.ts)
-- and there are 2 such rows in 89,123. Asked on 14 Sep whether "Upcoming --
-- sometime in future" should cover announced-but-undated games or narrow to
-- dated releases; the answer was DATED RELEASES. So "Upcoming" means
-- `release_from = tomorrow` and nothing else, the seed does not grow a third
-- pass, and the label is Paul's to reword.
create index if not exists games_release_date on games (release_date)
  where release_date is not null;

-- ---------------------------------------------------------------------------
-- 2. Genre pills
-- ---------------------------------------------------------------------------
-- Paul's 14 pills are not IGDB's 23 genre names, and four of them have no data
-- behind them at all. A table, not a CASE inside the function, so the mapping can
-- be read and changed without rewriting the ranking.
--
-- THE OPPOSITE CALL TO RELEASE DATE, ON PURPOSE. Date boundaries are a product
-- choice Paul will keep moving, so the app owns them. Genre rollups are a fact
-- about the catalog's data -- the app has no way to know that IGDB files
-- "Tactical" and "Real Time Strategy (RTS)" separately from "Strategy" -- so the
-- backend owns them and the app sends pill slugs.
create table if not exists genre_pills (
  pill  text not null,
  genre text not null,
  primary key (pill, genre)
);

insert into genre_pills (pill, genre) values
  ('adventure',  'Adventure'),
  ('rpg',        'Role-playing (RPG)'),
  ('fps',        'Shooter'),
  ('strategy',   'Strategy'),
  ('strategy',   'Turn-based strategy (TBS)'),
  ('strategy',   'Real Time Strategy (RTS)'),
  ('strategy',   'Tactical'),
  ('strategy',   'MOBA'),
  ('simulation', 'Simulator'),
  ('sports',     'Sport'),
  ('racing',     'Racing'),
  ('fighting',   'Fighting'),
  ('platformer', 'Platform'),
  ('puzzle',     'Puzzle'),
  ('puzzle',     'Point-and-click')
on conflict do nothing;

-- FOUR PILLS ARE DELIBERATELY ABSENT: `action`, `souls`, `open-world`,
-- `survival`. IGDB has no "Action" genre (it files those under Shooter, Fighting,
-- Hack and slash and Arcade), and Souls / Open World / Survival are themes and
-- keywords rather than genres. `games.themes` and `games.keywords` exist -- added
-- 11 Sep by 20260911120000_descriptive_fields.sql -- but hold nothing: 0 of
-- 89,123 rows carry a theme, a keyword or a summary.
--
-- DECIDED 14 SEP: NOT WORTH A RE-SEED. A pill the provider has no data for does
-- not get invented here; the app reconciles its pills with what exists. So this
-- table is the vocabulary, and it is readable by the app on purpose (the grant
-- below) so the pill row can be built from what is actually servable instead of
-- from a hardcoded list that silently rots when this one changes.
--
-- An unknown pill matches nothing rather than everything. That is the safe
-- failure: a user who taps `souls` gets an empty list, not the whole catalog
-- silently unfiltered.

comment on table genre_pills is
  'Maps a search-screen genre pill slug to the IGDB genre names it covers. '
  'action, souls, open-world and survival are absent because IGDB has no data '
  'behind them; decided 14 Sep not to re-seed for them. Readable by the app so '
  'the pill row can be built from what is servable: select distinct pill.';

-- Mirrors how every other catalog reference table is protected: RLS on, one
-- SELECT policy for `authenticated` with a `true` qualifier. Without RLS the
-- table would be readable by anon and the security advisor would flag it, which
-- is not a risk worth carrying for a lookup table but is inconsistency worth
-- avoiding. Checked against `platforms` before writing this.
alter table genre_pills enable row level security;

drop policy if exists "catalog readable by authenticated" on genre_pills;
create policy "catalog readable by authenticated"
  on genre_pills for select to authenticated using (true);

grant select on genre_pills to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The search function
-- ---------------------------------------------------------------------------
-- DROP, NOT `create or replace`. Adding parameters with defaults creates an
-- OVERLOAD rather than replacing the function, and two overloads make PostgREST
-- fail every call as ambiguous.
drop function if exists shelf_search_games(text, int);

create function shelf_search_games(
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
  if sort_by = 'recent' and release_from is null and release_to is null then
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
         b.score::real
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
     case when sort_by = 'best_match' then
       b.score + 0.15 * ln(1 + coalesce(g.total_rating_count, 0)) / ln(1 + 10000)
     end desc,
     case when sort_by = 'best_match' then g.critic_score end desc nulls last,
     -- Most Popular takes no direction (design, p5: "Most Popular does not need
     -- an order for example").
     case when sort_by = 'popular' then coalesce(g.total_rating_count, 0) end desc,
     -- Ratings is thin: critic_score is present on 8,952 of 89,123 rows (10.0%),
     -- so nulls last is doing most of the work and rating count breaks the tie.
     -- Flagged to Paul.
     case when sort_by = 'rating' and not asc_order then g.critic_score end desc nulls last,
     case when sort_by = 'rating' and     asc_order then g.critic_score end asc  nulls last,
     case when sort_by = 'rating' then coalesce(g.total_rating_count, 0) end desc,
     case when sort_by = 'recent' and not asc_order then g.release_date end desc nulls last,
     case when sort_by = 'recent' and     asc_order then g.release_date end asc  nulls last,
     case when sort_by = 'alpha'  and not asc_order then g.title end desc,
     case when sort_by = 'alpha'  and     asc_order then g.title end asc,
     -- Every sort ends on a stable tiebreak, or equal rows shuffle between pages.
     g.id
   limit greatest(max_results, 1);
end;
$$;

-- Migration 000700's rule, and it bites every single time a function is replaced:
-- `create or replace` restores the default PUBLIC execute grant, and `authenticated`
-- inherits from PUBLIC, so anon silently regains execute on search. A drop-and-
-- create does the same. Re-issue both.
-- Check with: select proacl from pg_proc where proname = 'shelf_search_games';
revoke all on function shelf_search_games(text, int, date, date, text[], text[], text, text)
  from public, anon;
grant execute on function shelf_search_games(text, int, date, date, text[], text[], text, text)
  to authenticated;
