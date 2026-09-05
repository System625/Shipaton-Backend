-- Apostrophes are dropped, not turned into a space. Source: docs/spec.md section 5.
--
-- Found by running the normalizer against real titles rather than reading it:
-- the `[^a-z0-9 ]` class replaced every apostrophe with a space, so
-- "Baldur's Gate 3" normalized to "baldur s gate 3" with a stranded "s".
--
-- The cost is not the typed case -- "baldurs gate 3" still scored 0.72 against the
-- stranded form, comfortably confident. The cost is the run-together hashtag path
-- that share ingestion depends on (see the #eldenring arithmetic in oembed.ts):
--
--   catalog            typed          before  after
--   No Man's Sky       nomanssky      0.294   0.375   <- was below the 0.30 floor
--   Garry's Mod        garrysmod      0.467   0.615
--   Dragon's Dogma 2   dragonsdogma2  0.429   0.526
--   Baldur's Gate 3    baldurs gate 3 0.722   1.000
--
-- At 0.294 "No Man's Sky" was not merely ranked low, it was invisible: the `%`
-- operator filters at pg_trgm.similarity_threshold, which defaults to 0.30, so the
-- row never came back at all. Every measured case improves and none regress.
--
-- Both the ASCII apostrophe and U+2019 are handled: IGDB titles use both, and
-- unaccent() does not fold the typographic one to ASCII.
create or replace function shelf_match_title(input text)
returns text
language sql
immutable
set search_path = extensions, public, pg_catalog
as $$
  select btrim(regexp_replace(
    regexp_replace(
      shelf_roman_to_digits(
        regexp_replace(
          -- apostrophes vanish before anything else, so "Baldur's" -> "baldurs"
          -- rather than "baldur s". The edition-suffix pattern below is unaffected:
          -- its "director''?s cut" already makes the apostrophe optional.
          translate(unaccent(lower(coalesce(input, ''))), '''’', ''),
          '\y(game of the year( edition)?|goty|definitive edition|complete edition|'
          || 'director''?s cut|enhanced edition|remastered|remaster|deluxe( edition)?|'
          || 'special edition|ultimate edition|anniversary edition)\y',
          ' ', 'g')),
      '[^a-z0-9 ]', ' ', 'g'),
    '\s+', ' ', 'g'));
$$;

-- match_title is a stored column, so existing rows keep the old normalization until
-- rewritten. Harmless on an empty catalog; required if this ever lands after a seed.
update games set title = title where title is not null;
