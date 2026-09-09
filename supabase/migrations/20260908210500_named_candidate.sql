-- Ask the naming question of the whole candidate list, not just the top row.
--
-- THE BUG THIS FIXES, from the same 21-link batch as 20260908195307. A caption reads:
--
--   "This gameplay turned into a movie 💀 #battlefield5 #battlefieldv #gamingvideo ..."
--
-- `#battlefield5` normalizes to 'battlefield5', and Battlefield V's own title
-- normalizes to 'battlefield 5' (shelf_roman_to_digits turns the V into a 5), so with
-- spaces removed the tag IS the game's name -- exactly the claim shelf_term_names_game
-- exists to make. The share came back unmatched anyway, because trigram similarity
-- ranked four other Battlefield games above it:
--
--   Battlefield 3   0.60   <- candidates[0], not named by the tag -> not confident
--   Battlefield 4   0.60
--   Battlefield 1   0.60
--   Battlefield V   0.55   <- named by the tag exactly, never looked at
--
-- /share-resolve only ever tested candidates[0]. A fuzzier row scoring a hair higher
-- silently vetoes a row the tag literally names, and noise tags produce those rows
-- constantly (#gameplay -> "The End of Gameplay", #shorts -> "Cursed Shorts",
-- #playstation -> "PlayStation Home"). Ranking and naming are different questions.
--
-- Each candidate is checked against the term that FOUND it, never against another
-- candidate's term, so this cannot invent a match across two unrelated hashtags. The
-- first pair that holds wins, in score order, and /share-resolve promotes that row to
-- the front of the list.
--
-- One round trip rather than one per candidate: five index lookups inside the database
-- cost less than five HTTP calls from the edge function, and the endpoint is already
-- doing up to four searches per share.
create or replace function shelf_named_candidate(terms text[], ids uuid[])
returns uuid
language sql
stable
set search_path = public, extensions
as $$
  select ids[i]
    from generate_subscripts(ids, 1) as i
   where shelf_term_names_game(terms[i], ids[i])
   order by i
   limit 1;
$$;

-- Migration 000700's rule: a new function gets Supabase's default grants, which
-- include EXECUTE for anon. Revoke before granting.
revoke all on function shelf_named_candidate(text[], uuid[]) from public, anon;
grant execute on function shelf_named_candidate(text[], uuid[]) to authenticated;
