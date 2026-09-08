-- Store IGDB's `total_rating_count` on games.
--
-- The seed has always *filtered* on this field (`seedPopularPageQuery`) and never
-- stored it, so the catalog has no popularity signal at all. Two things need one:
--
--   /games/popular   -- Sola asked for it; there is nothing to order by today
--   STATUS section 4b -- `cyberpunk` returns Cyberpunk SFX and Cyberpunk Sex above
--                        Cyberpunk 2077, because shelf_search_games ranks on
--                        trigram similarity alone and similarity favours SHORT
--                        titles. That is a ranking problem, not a matching one,
--                        and no amount of alt-title work fixes it.
--
-- It is IGDB's count of *user* ratings, not a score. Do not confuse it with
-- `critic_score` (IGDB's aggregate of external critic scores, 0-100), which is
-- already stored and is a different quantity: a game can be widely played and
-- mediocre, or acclaimed and obscure. Measured against the live API on 8 Sep:
--
--   Grand Theft Auto V   5,952        Cyberpunk SFX     (omitted)
--   Elden Ring           2,287        Cyberpunk Sex     (omitted)
--   Cyberpunk 2077       1,647        Cyberpunk Horror  (omitted)
--
-- NULL and 0 mean different things, and the backfill depends on the difference.
-- IGDB OMITS the field entirely when a game has no user ratings -- it does not
-- return 0 -- so the sync layer writes an explicit 0 in that case. NULL therefore
-- means "IGDB returned no row for this igdb_id at all", which happens when an id is
-- deleted or merged upstream, and is worth being able to see. Nothing downstream
-- should read NULL as "unpopular"; use `coalesce(total_rating_count, 0)`.
--
-- No default, for the same reason: a default of 0 would silently turn every
-- un-backfilled row into a claim that we checked and found no ratings.
alter table games add column total_rating_count int;

-- Serves /games/popular (`order by total_rating_count desc limit n`). It is
-- deliberately NOT partial: a partial index would be far smaller, since most of the
-- 89,117 rows will land on 0, but it would only be usable by queries that repeat
-- its predicate, and at this table size the whole index is a couple of megabytes.
create index games_total_rating_count on games (total_rating_count desc nulls last);

comment on column games.total_rating_count is
  'IGDB user rating COUNT, not a score. 0 = no ratings; NULL = never fetched, or the igdb_id is gone upstream.';
