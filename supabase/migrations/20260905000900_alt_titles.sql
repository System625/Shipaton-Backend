-- Alternative titles, so abbreviations match. Source: docs/STATUS.md step 3b.
--
-- Before this, "bg3", "gta v", "gta5" and "zelda botw" returned NOTHING -- not a low
-- score, nothing. Trigram similarity shares almost no trigrams between an
-- abbreviation and a full title, so `%` filtered them out before ranking ever ran.
-- IGDB's `alternative_names` is the field for these. Verified against IGDB's own
-- type definitions: `Game.alternative_names` exists, and `AlternativeName.comment`
-- is documented as "A description of what kind of alternative name it is (Acronym,
-- Working title, Japanese title etc)" -- so Acronym is a real category.
--
-- NOT verified, because it needs live credentials: how many games actually carry an
-- acronym. Coverage is unmeasured. Take the real number during the seed; if it is
-- thin, this table helps less than the test numbers below suggest. The scores in
-- docs/STATUS.md were measured against hand-written rows, so they show the ranking
-- mechanism working, not IGDB's data quality.
--
-- A child table rather than a text[] column on `games`, because pg_trgm cannot index
-- array elements. An array would support only exact `@>` matching, which does fix
-- "bg3" but still misses "gta5" (alt "GTA V" normalizes to "gta 5" -- close, not
-- equal) and "zelda botw" (extra word). Fuzzy matching needs a real trigram index,
-- and a trigram index needs its own row per title.
create table game_alt_titles (
  game_id     uuid not null references games(id) on delete cascade,
  alt_title   text not null,               -- as IGDB spells it, for display/debugging
  match_title text not null,               -- normalized by trigger, never written by hand
  -- Keyed on the NORMALIZED form: IGDB often lists several spellings that normalize
  -- identically ("GTA V", "GTA 5", "G.T.A. V" -> all "gta 5"). Storing one row each
  -- would triple the index for no matching benefit.
  primary key (game_id, match_title)
);

create index game_alt_titles_trgm
  on game_alt_titles using gin (match_title extensions.gin_trgm_ops);

-- Same single-implementation rule as games.match_title: normalization is the
-- database's job, so alt titles and query text cannot drift apart.
create or replace function shelf_alt_titles_set_match_title()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.match_title := shelf_match_title(new.alt_title);
  return new;
end;
$$;

create trigger game_alt_titles_match_title
  before insert or update of alt_title on game_alt_titles
  for each row execute function shelf_alt_titles_set_match_title();

alter table game_alt_titles enable row level security;
create policy "catalog readable by authenticated"
  on game_alt_titles for select to authenticated using (true);

-- Covering index for the FK, per the same linter rule as migration 000800. The
-- primary key already leads with game_id, so no extra index is needed here.

-- Search now considers both the canonical title and every alternative, taking the
-- better score per game. Return shape is unchanged, so no caller has to change.
create or replace function shelf_search_games(q text, max_results int default 5)
returns setof shelf_catalog_row
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  needle text := shelf_match_title(q);
begin
  if needle = '' then
    return;
  end if;

  return query
  with hits as (
    select g.id, similarity(g.match_title, needle) as score
      from games g
     where g.match_title % needle
    union all
    -- Scaled by 0.98 so a canonical-title match outranks an alternative-title match
    -- of equal raw similarity. This only ever breaks ties BETWEEN DIFFERENT GAMES --
    -- a game matching on both keeps the higher of the two via max() below, and 0.98
    -- of a passing score is still a passing score at both the 0.55 and 0.30 bands.
    select a.game_id, similarity(a.match_title, needle) * 0.98
      from game_alt_titles a
     where a.match_title % needle
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
   order by b.score desc, g.critic_score desc nulls last
   limit greatest(max_results, 1);
end;
$$;

-- Same lockdown as migrations 000500/000700: authenticated only, never anon.
revoke all on function shelf_alt_titles_set_match_title() from public, anon;
revoke all on function shelf_search_games(text, int)      from public, anon;
grant execute on function shelf_search_games(text, int)   to authenticated;
