-- shelf_search_games: make an explicit NULL sort_by behave like the default.
--
-- The ranking lived in a chain of `case when sort_by = '<mode>' then ... end`
-- expressions, and `sort_by` was the only one of the two sort parameters with no
-- coalesce -- `sort_dir` was already resolved through `coalesce(sort_dir,'desc')`
-- one line above. So a caller passing an explicit null (rather than omitting the
-- argument and taking the `default 'best_match'`) made EVERY branch evaluate to
-- NULL, which left the final `g.id` tiebreak as the only ordering. The function
-- returned the right rows in arbitrary order.
--
-- Measured 16 Sep 2026, before the fix:
--   shelf_search_games('Sekiro: Shadows Die Twice', 3, ..., sort_by => null)
--     -> Dual Shadows (0.32), Seal of Shadows (0.30), Sekiro: Shadows Die Twice (1.00)
-- The exact match, scoring a clean 1.0, came back third.
--
-- **This was never reachable from the app.** supabase/functions/search/index.ts
-- defaults the query parameter to 'best_match' and rejects any value outside
-- SORTS, so it cannot pass null. The caller that hit it was the vague-search
-- grounding step, which looks a model-produced title up through this function and
-- takes the first row -- and scored 0% on all 71 eval queries as a result, with
-- the correct game sitting in the result set the whole time.
--
-- The fix is the coalesce that sort_dir always had. Behaviour for every existing
-- caller is identical: 'best_match' resolves to 'best_match'.
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

-- Migration 000700's rule, and it bites every single time a function is replaced:
-- `create or replace` restores the default PUBLIC execute grant, and `authenticated`
-- inherits from PUBLIC, so anon silently regains execute on search. Re-issue both.
-- Check with: select proacl from pg_proc where proname = 'shelf_search_games';
revoke all on function shelf_search_games(text, int, date, date, text[], text[], text, text)
  from public, anon;
grant execute on function shelf_search_games(text, int, date, date, text[], text[], text, text)
  to authenticated;
