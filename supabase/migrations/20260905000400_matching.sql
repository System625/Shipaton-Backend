-- Title normalization and search. Source: docs/spec.md section 5.
--
-- This is the single implementation of the normalization rules. The seed script,
-- /search and share matching all route through shelf_match_title(), so catalog
-- titles and incoming query text cannot drift apart.

create extension if not exists unaccent with schema extensions;

-- Roman numerals to digits, ii through x (spec step 4).
-- Each pattern is anchored on both sides, so replacement order does not matter.
--
-- Bare "i" is deliberately NOT converted: "I Am Setsuna" and "I Expect You To Die"
-- would become "1 am setsuna" and "1 expect you to die". Bare "x" and "v" ARE
-- converted because "Final Fantasy X" and "Grand Theft Auto V" are the common case.
-- Known cost: "Mega Man X" normalizes to "mega man 10" and collides with the real
-- "Mega Man 10". Both sides of a comparison run through this function, so the
-- failure is a false match between those two, not a failure to find either.
create or replace function shelf_roman_to_digits(input text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(
                       regexp_replace(
                         regexp_replace(coalesce(input, ''),
                           '\yviii\y', '8',  'g'),
                         '\yvii\y',    '7',  'g'),
                       '\yiii\y',      '3',  'g'),
                     '\yix\y',         '9',  'g'),
                   '\yiv\y',           '4',  'g'),
                 '\yvi\y',             '6',  'g'),
               '\yii\y',               '2',  'g'),
             '\yx\y',                  '10', 'g'),
           '\yv\y',                    '5',  'g');
$$;

-- 1. lowercase  2. strip diacritics  3. drop edition suffixes
-- 4. roman numerals to digits  5. strip punctuation, collapse whitespace
--
-- "The Witcher III: Wild Hunt - Game of the Year Edition" -> "the witcher 3 wild hunt"
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
          unaccent(lower(coalesce(input, ''))),
          '\y(game of the year( edition)?|goty|definitive edition|complete edition|'
          || 'director''?s cut|enhanced edition|remastered|remaster|deluxe( edition)?|'
          || 'special edition|ultimate edition|anniversary edition)\y',
          ' ', 'g')),
      '[^a-z0-9 ]', ' ', 'g'),
    '\s+', ' ', 'g'));
$$;

-- Keep match_title in lockstep with title without every writer having to remember.
create or replace function shelf_games_set_match_title()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.match_title := shelf_match_title(new.title);
  return new;
end;
$$;

create trigger games_match_title
  before insert or update of title on games
  for each row execute function shelf_games_set_match_title();
