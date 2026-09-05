-- Drop alternative titles that normalize to nothing useful.
--
-- IGDB's `alternative_names` is not a list of acronyms. Its `comment` field is
-- documented as "A description of what kind of alternative name it is (Acronym,
-- Working title, Japanese title etc)" -- so the same field carries CJK and Cyrillic
-- titles, and shelf_match_title() strips everything outside [a-z0-9 ]:
--
--   ゼルダの伝説 ブレス オブ ザ ワイルド  ->  ''      (empty)
--   Ведьмак 3: Дикая Охота              ->  '3'     (one character)
--   巫师3：狂猎                          ->  '3'
--   BG3                                 ->  'bg3'   (what we actually want)
--
-- Unfiltered, a 100k-game seed writes a large number of empty and single-character
-- rows into the trigram index. The empty ones can never match anything; the '3' ones
-- are worse, because they are real index entries that match short numeric queries
-- and attach them to whichever game happened to have a Russian title.
--
-- Two characters is the floor because real acronyms go that short ("ER"), and
-- trigram similarity on a 2-char string almost never clears 0.30 against a real
-- query anyway, so they cost nothing when they are useless.
--
-- Returning NULL from a BEFORE INSERT row trigger skips that row silently, which is
-- what we want: one unusable alternative title must not fail a 500-row seed page.
create or replace function shelf_alt_titles_set_match_title()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.match_title := shelf_match_title(new.alt_title);
  if length(new.match_title) < 2 then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function shelf_alt_titles_set_match_title() from public, anon;

-- Clear any rows written before this rule existed. No-op on a fresh database.
delete from game_alt_titles where length(match_title) < 2;
