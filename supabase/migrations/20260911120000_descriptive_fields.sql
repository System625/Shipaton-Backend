-- Descriptive text, so vague search has something to match on.
-- Source: docs/research/semantic-search.md.
--
-- WHY THIS IS NEEDED AT ALL. The catalog stores no prose. `keywords` and
-- `game_modes` are already fetched from IGDB on every seed page, fed to
-- deriveSessionFit(), and then thrown away; `summary`, `storyline`, `themes` and
-- `player_perspectives` were never requested. So the only text any search can match
-- is the title. Measured on 11 Sep against 7,250 real games and 77 real
-- "name that game" queries, lexical search over the title alone answers 0% of them.
--
-- WHAT IS AND IS NOT WORTH STORING, measured against IGDB the same day over the
-- 15,053 main games with >= 5 ratings:
--
--   summary               15,021 / 15,053  (99.8%)   keep
--   storyline              5,385 / 15,053  (35.8%)   keep, nullable, often absent
--   themes                 ~all                      keep, small controlled vocab
--   player_perspectives    ~all                      keep, tiny controlled vocab
--   keywords               ~77 per popular game      keep, but see the warning below
--
-- KEYWORDS ARE NOISY AND THE NOISE IS STRUCTURAL. IGDB has 7,512 keywords and they
-- are crowd-entered. Hollow Knight carries 40, of which "steam trading cards",
-- "xbox controller support for pc" and "available on - luna plus" describe the
-- storefront, not the game. Sekiro carries 12, seven of which are award-show
-- trivia ("the game awards - best art direction - nominee"). They are stored
-- because they are cheap and occasionally carry the only useful signal
-- ("metroidvania", "feudal japan"), NOT because they can be trusted as a
-- description. Do not weight them above summary without measuring.
--
-- AND KEYWORDS DO NOT CONTAIN WHAT YOU EXPECT. IGDB has a `difficult` keyword
-- applied to 864 games including Elden Ring, Dark Souls and Celeste. It is NOT
-- applied to Sekiro. There is no `prosthetic` keyword at all. The "really hard"
-- and "metal arm" signals in Josh's example query are not in this data and no
-- amount of indexing it will find them -- that is what the enrichment column and
-- Steam tags are for, and it is why this migration alone does not ship the feature.

alter table games
  add column if not exists summary      text,
  add column if not exists storyline    text,
  add column if not exists themes       text[] not null default '{}',
  add column if not exists perspectives text[] not null default '{}',
  add column if not exists keywords     text[] not null default '{}';

comment on column games.summary is
  'IGDB summary. Marketing prose describing the product, not what a player remembers. 99.8% coverage on rated games.';
comment on column games.storyline is
  'IGDB storyline. Plot synopsis. Only ~36% of rated games have one -- treat absence as normal.';
comment on column games.keywords is
  'IGDB crowd keywords. Heavily polluted with storefront and award-show trivia. See this migration for why.';

-- No index here on purpose. A GIN/tsvector index over this text is the thing that
-- was measured at 0% recall on real queries, so building one would cost storage to
-- buy nothing. The retrieval path is pgvector over LLM-written enrichment; add the
-- index only if a measured hybrid actually beats vector-alone on
-- scripts/search-lab/reddit-eval.tsv.
--
-- Storage: ~600 chars of summary across 89,123 rows is roughly 53 MB, against
-- ~390 MB of headroom on the free tier. The embedding table is the other big
-- consumer -- halfvec(512) over the full catalog is ~193 MB with its HNSW index --
-- so these two together are most of the remaining budget. Check
-- pg_size_pretty(pg_database_size(current_database())) after the re-seed.
