-- A non-Latin alternative title does not normalize to a shorter name. It normalizes
-- to whatever Latin characters happened to survive, and that residue is then indexed
-- as if it were a name.
--
-- THE BUG THIS FIXES, found by running the deployed endpoint against 21 real gaming
-- TikTok links. One caption reads:
--
--   "Eldin Ring #eldinring #gameplay #foryou #2023 #gaming #games #shorts ..."
--
-- `#2023` expands to the term "2023", and /share-resolve returned `confident: true`
-- for a game called *A Chinese Ghost Story 2023*. Not because the threshold was too
-- low -- the confidence guard from migration 20260908183000 was doing exactly what it
-- says, asserting only when the term IS one of the game's names:
--
--   game_alt_titles.alt_title  '倩女幽魂2023'  ->  match_title  '2023'
--   game_alt_titles.alt_title  '猎鹰2023'      ->  match_title  '2023'
--
-- shelf_match_title() strips everything outside [a-z0-9 ], so a Chinese title is not
-- normalized, it is *deleted*, and the year it was released in is left standing alone
-- as an exact, indexed name. The term "2023" genuinely equals that stored name. The
-- claim the guard makes is true; the data it makes the claim about is junk.
--
-- Migration 20260905001000 already saw this shape ("the '3' ones are worse, because
-- they are real index entries that match short numeric queries and attach them to
-- whichever game happened to have a Russian title") and set a floor of two characters.
-- That floor is what let '2023' through: four characters, and a year is one of the
-- most common hashtags on TikTok. Length was never the property that mattered.
--
-- THE RULE. A title whose non-Latin characters were destroyed by normalization is a
-- residue, not a name, and a residue may only be kept when it is distinctive enough to
-- stand on its own: three or more characters and not purely numeric. Written the other
-- way round, these three are unrelated and only the last is a name:
--
--   '倩女幽魂2023'  -> '2023'      residue, numeric      -> dropped
--   'イースII'      -> 'ii'        residue, two chars    -> dropped
--   'Nier: Automata【ニーア】' -> 'nier automata'         -> KEPT, still a real name
--   '007'          -> '007'       no non-Latin at all   -> KEPT, a genuine acronym
--
-- Mixed-script titles are the reason this is not simply "drop anything with a CJK
-- character": the Latin half of such a title is usually the name we most want.
--
-- Measured on the live catalog before applying: 131 numeric residues and 171 two-
-- character residues qualify, against 9 genuinely ASCII numeric alt titles (like
-- '007') which are kept, out of 62,685 alt titles in total.
create or replace function shelf_alt_titles_set_match_title()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  new.match_title := shelf_match_title(new.alt_title);

  -- Unchanged from 20260905001000: nothing under two characters is ever useful.
  if length(new.match_title) < 2 then
    return null;
  end if;

  -- unaccent() first, so that 'Pokémon' and 'Ōkami' count as Latin and are unaffected.
  -- What is left non-ASCII after that is a script shelf_match_title() cannot represent.
  if unaccent(lower(new.alt_title)) ~ '[^\x00-\x7F]'
     and (length(replace(new.match_title, ' ', '')) < 3
          or new.match_title ~ '^[0-9 ]+$') then
    return null;
  end if;

  return new;
end;
$$;

-- Clear the rows written before this rule existed. The alt_title itself is only ever
-- used for display and debugging, and every one of these rows is a title whose actual
-- name is unreachable from a Latin query anyway, so nothing searchable is lost.
delete from game_alt_titles
 where unaccent(lower(alt_title)) ~ '[^\x00-\x7F]'
   and (length(replace(match_title, ' ', '')) < 3 or match_title ~ '^[0-9 ]+$');

-- Belt and braces, and the half that also covers games.title. A purely numeric term is
-- not a distinctive claim to a name even when it matches one exactly: a video tagged
-- '#2023' is dated, not titled. Such a game still comes back in `candidates` -- it just
-- stops being asserted as the answer.
create or replace function shelf_term_names_game(term text, p_game_id uuid)
returns boolean
language sql
stable
set search_path = public, extensions
as $$
  with needle as (select shelf_match_title(term) as t)
  select exists (select 1 from needle where t <> '' and t !~ '^[0-9 ]+$')
     and (
           exists (
             select 1
               from games g, needle
              where g.id = p_game_id
                and replace(g.match_title, ' ', '') = replace(needle.t, ' ', '')
           )
        or exists (
             select 1
               from game_alt_titles a, needle
              where a.game_id = p_game_id
                and replace(a.match_title, ' ', '') = replace(needle.t, ' ', '')
           )
         );
$$;

-- Migration 000700's rule, which every `create or replace` has to repeat: a replaced
-- function gets Supabase's default privileges back, which grant EXECUTE to anon.
revoke all on function shelf_alt_titles_set_match_title() from public, anon;
revoke all on function shelf_term_names_game(text, uuid)  from public, anon;
grant execute on function shelf_term_names_game(text, uuid) to authenticated;
