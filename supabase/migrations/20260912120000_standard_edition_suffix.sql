-- The normalizer strips every fancy edition suffix and misses the plain one.
--
-- `shelf_match_title()` has dropped "Game of the Year", "Definitive Edition",
-- "Ultimate Edition", "Anniversary Edition" and friends since migration 000400.
-- It has never dropped "Standard Edition" -- which is the single most common
-- suffix in the wild, because PSN and the Microsoft Store append it to the BASE
-- version of nearly every game. The fancy ones are the exception; the plain one
-- is the rule.
--
-- MEASURED 12 Sep 2026 against the live catalog, while checking whether title
-- matching could stand in for an ID join on the Xbox and PlayStation imports
-- (docs/research/account-linking.md section 2a). Two unrelated store names came
-- back with the SAME wrong game, and the right answer nowhere in the top 5:
--
--   "Avowed Standard Edition"    -> Metal Storm  (0.490)
--   "WWE 2K25 Standard Edition"  -> Metal Storm  (0.463)
--
-- The mechanism is worth understanding before anyone shortens this list again.
-- With the suffix surviving normalization, 16 of the query's 23 characters are
-- "standard edition". Exactly 10 rows out of 62,466 in `game_alt_titles` happen
-- to end in an edition suffix, and those ten become trigram magnets for any such
-- query -- scoring ~0.4-0.5 -- while the true title, being short, scores lower:
--
--   metal storm standard edition       0.500
--   endless legend standard edition    0.459
--   riders republic standard edition   0.436
--   forza motorsport standard edition  0.415
--
-- So this is NOT an import-only defect. It is live in /search today: any user who
-- types or pastes a title carrying "Standard Edition" gets those same ten games.
--
-- Verified against the live catalog by running the new normalization inline:
--
--   query                            before                  after
--   Avowed Standard Edition          Metal Storm    0.490    Avowed         1.00
--   WWE 2K25 Standard Edition        Metal Storm    0.463    WWE 2K25       1.00
--   Halo Infinite Standard Edition   Halo Infinite  0.452    Halo Infinite  1.00
--
-- Added alongside "standard": gold, premium, legendary and digital, the other
-- store-applied suffixes IGDB's alternative_names carry. Deliberately NOT added:
-- "collector's" and "limited", which frequently name a genuinely distinct physical
-- product rather than a label on the base game.
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
          || 'special edition|ultimate edition|anniversary edition|'
          -- new in this migration
          || 'standard edition|gold edition|premium edition|legendary edition|'
          || 'digital edition)\y',
          ' ', 'g')),
      '[^a-z0-9 ]', ' ', 'g'),
    '\s+', ' ', 'g'));
$$;

-- `match_title` is written by a trigger, so existing rows keep the OLD
-- normalization until they are rewritten. Skipping this would fix the function for
-- incoming queries while leaving the ten poisoned alt titles in the trigram index
-- -- which is where the bug actually lives. So the rewrite is the fix, not cleanup.
--
-- Only 26 rows change (16 games, 10 alt titles), measured before writing this, so
-- both statements are filtered rather than rewriting 89k + 62k rows and their GIN
-- indexes for nothing.

-- games.match_title carries no unique constraint, so a plain update is safe.
update games
   set title = title
 where title is not null
   and match_title is distinct from shelf_match_title(title);

-- game_alt_titles cannot be updated in place: `match_title` is half of the primary
-- key `(game_id, match_title)`, and the whole point of this change is that rows
-- COLLAPSE onto one another -- "metal storm standard edition" becomes "metal
-- storm", which may already exist for that game. A plain update would raise a
-- duplicate key error on exactly the rows we are trying to fix. So: capture,
-- delete, re-insert and let the existing conflict rule absorb the collisions.
-- Dropped explicitly at the end rather than with `on commit drop`, which would need
-- this file to be running inside a transaction to survive to the next statement.
create temporary table alt_title_rewrite as
  select game_id, alt_title
    from game_alt_titles
   where match_title is distinct from shelf_match_title(alt_title);

delete from game_alt_titles a
 using alt_title_rewrite r
 where a.game_id = r.game_id
   and a.alt_title = r.alt_title;

-- The BEFORE INSERT trigger recomputes match_title (and still drops sub-2-character
-- junk by returning null), so the conflict target is the freshly normalized value.
insert into game_alt_titles (game_id, alt_title)
select game_id, alt_title from alt_title_rewrite
on conflict (game_id, match_title) do nothing;

drop table alt_title_rewrite;
