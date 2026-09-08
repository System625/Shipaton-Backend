-- Does a piece of shared text actually NAME this game, rather than merely look a
-- bit like it? Used by /share-resolve to decide the `confident` flag on TikTok.
--
-- THE BUG THIS FIXES, found by running the deployed endpoint against a real link.
-- TikTok's own documented example video is a pet clip captioned
--
--   "Scramble up ur name & I'll try to guess it😍❤️ #foryoupage #petsoftiktok #aesthetic"
--
-- `#aesthetic` expands to the term "aesthetic", and trigram similarity against the
-- seeded catalog gives:
--
--   Aestheta           0.583   0 ratings
--   Aesthetic Clicker  0.556   0 ratings
--
-- Both clear the 0.55 confident threshold, so the endpoint returned
-- `confident: true` for "Aestheta" on a video about dogs. `confident` means "show
-- this one large", which is precisely the way to make the one feature that makes
-- this app different look broken.
--
-- WHY THE THRESHOLD WAS WRONG, not just badly tuned. 0.55 was chosen for text that
-- is a genuine attempt at a title: a typed search query, or a YouTube title, which
-- really is the game's name plus noise. A TikTok hashtag is not an attempt at a
-- title -- it is an arbitrary tag that happens to be a word. Fuzzy proximity is not
-- evidence there, so no threshold value fixes this. The signal that does hold is the
-- stronger claim: the tag IS one of the game's names.
--
-- THE RULE. Compare the normalized term against the game's normalized title and
-- alternative titles with spaces removed. Spaces are dropped because that is the one
-- difference a hashtag genuinely cannot express -- "#eldenring" cannot be split
-- without a dictionary -- while every other difference is a different word.
-- Measured against the real catalog:
--
--   eldenring  -> Elden Ring              0.615  same letters   -> confident
--   hades 2    -> Hades II                1.000  same letters   -> confident   (roman numerals)
--   silksong   -> Hollow Knight: Silksong 0.391  alt title hit  -> confident
--   aesthetic  -> Aestheta                0.583  DIFFERENT      -> not confident
--
-- Note silksong: scoring 0.391 it was never confident under the threshold rule even
-- though the tag is exactly the game's alt title. This rule is not only stricter,
-- it is right in both directions.
--
-- Rejected candidates are still returned in `candidates`. Nothing is hidden from the
-- user; they just stop being asserted.
--
-- PERFORMANCE. Both lookups are scoped to a single game id, so they are index
-- lookups on the primary key and on game_alt_titles(game_id). Do NOT be tempted to
-- turn this into a catalog-wide `where replace(match_title,' ','') = ...` search:
-- that expression is not indexable, and over 89k games plus 62k alt titles it
-- sequentially scans both. Measured: it times out.
create or replace function shelf_term_names_game(term text, p_game_id uuid)
returns boolean
language sql
stable
set search_path = public, extensions
as $$
  select exists (
           select 1
             from games g
            where g.id = p_game_id
              and replace(g.match_title, ' ', '')
                  = replace(shelf_match_title(term), ' ', '')
         )
      or exists (
           select 1
             from game_alt_titles a
            where a.game_id = p_game_id
              and replace(a.match_title, ' ', '')
                  = replace(shelf_match_title(term), ' ', '')
         );
$$;

-- A newly created function gets Supabase's default privileges, which grant EXECUTE
-- to anon. Migration 000700 explains why that has to be revoked explicitly rather
-- than assumed. Every function in this schema has to repeat this; forgetting it is
-- how anon silently regains execute.
revoke all on function shelf_term_names_game(text, uuid) from public, anon;
grant execute on function shelf_term_names_game(text, uuid) to authenticated;
