-- Exact-name recall and multi-token queries. Closes STATUS section 7 ("the next
-- thing worth building here") and the two cases section 4b left open.
--
-- Both defects are one problem wearing two hats: `shelf_search_games` had exactly
-- one way to find a row -- whole-needle trigram similarity -- and a query that is
-- the game's name with the spaces taken out, or two fragments of two different
-- names, is not similar to anything. Ranking was never the issue; the wanted row
-- was not in the candidate set at all, or was below the top 5 where the share
-- flow's promotion step (`shelf_named_candidate`, 20260908210500) could not reach it.
--
-- MEASURED AGAINST THE LIVE CATALOG, 12 Sep 2026, before and after:
--
--   query           before (top 1)                after (top 1)
--   awayout         Away             0.444        A Way Out              1.000
--   battlefield6    Battlefield 3    0.688        Battlefield 6          1.000
--   dragonsdogma2   Dragon's Dogma   0.588        Dragon's Dogma II      1.000
--   zelda botw      Hyrule Warriors  0.535        Breath of the Wild     0.600
--
-- In every one of those the wanted row exists in the catalog and carries more
-- ratings than nothing -- A Way Out has 676 -- so this is recall, not data.
--
-- WHY EXPRESSION INDEXES AND NOT THE GENERATED COLUMN STATUS PROPOSED. STATUS
-- section 7 suggested "a generated spaces-removed column with a btree index". An
-- index on the expression does the same work, needs no table rewrite of 89k rows,
-- and -- the reason that decided it -- `shelf_term_names_game` (20260908183000)
-- ALREADY writes `replace(match_title, ' ', '')` verbatim, so the same index serves
-- it for free. That function's comment warns in capitals that a catalog-wide
-- squashed lookup "is not indexable" and "times out". After this migration that
-- warning is out of date: the expression is indexed and the lookup is a btree
-- probe. Leave the per-game form there alone regardless -- it is scoped to one id
-- and is already a primary-key lookup.
--
-- WHY `simple` AND NOT `english` FOR THE TOKEN INDEX. match_title is already
-- lowercased, unaccented and reduced to [a-z0-9 ], so stemming would only invent
-- collisions ("ring" and "rings", "war" and "wars" are different games), and the
-- english stopword list would delete the tokens in "The Last of Us" and "God of
-- War" -- a query made entirely of stopwords would then cover nothing. `simple`
-- keeps every word exactly as stored, which is the whole point.

create index games_match_title_squashed
  on games (replace(match_title, ' ', ''));

create index game_alt_titles_match_title_squashed
  on game_alt_titles (replace(match_title, ' ', ''));

create index games_match_title_fts
  on games using gin (to_tsvector('simple', match_title));

create index game_alt_titles_match_title_fts
  on game_alt_titles using gin (to_tsvector('simple', match_title));

-- THE SCORE CONTRACT CHANGES HERE, AND IT IS LOAD-BEARING. READ THIS BEFORE
-- TOUCHING THE NUMBERS.
--
-- `score` used to be raw trigram similarity and nothing else. It is now the best
-- evidence found by ANY of five arms, so it is no longer reproducible by calling
-- `similarity(match_title, needle)` -- someone will try, and get a smaller number.
-- What it still is, and what both consumers actually need, is a confidence in
-- [0,1] comparable against the same two thresholds as before:
--
--   supabase/functions/search/index.ts   LIVE_LOOKUP_THRESHOLD 0.55
--   supabase/functions/share-resolve/index.ts  CONFIDENT 0.55, PLAUSIBLE 0.30
--
-- The blended popularity bonus from 20260908154949 is still ordering-only and is
-- still NOT in `score` -- that separation is unchanged and must stay.
--
-- The five arms, and why each scores what it does:
--
--   1. canonical title, trigram          similarity        unchanged
--   2. alternative title, trigram        similarity * 0.98 unchanged
--   3. canonical title, spaces removed   1.00
--   4. alternative title, spaces removed 0.98
--   5. every query token accounted for   0.60 floor
--
-- Arm 3 scores 1.00 because a needle that equals the stored name with the spaces
-- removed IS the name. That is not a new claim invented here -- it is exactly the
-- rule `shelf_term_names_game` already uses to assert `confident` on a hashtag,
-- and the only difference a hashtag genuinely cannot express is the space. The
-- 0.98 on arm 4 keeps the existing convention that a canonical title outranks an
-- alternative one.
--
-- COLLISION RISK OF ARMS 3 AND 4, MEASURED RATHER THAN ASSUMED. Squashing maps
-- 89,122 titles onto 87,503 distinct keys: 1,373 keys collide, covering 2,992 rows
-- (3.4%). Almost all are the SAME NAME reused -- Portal [4012] and Portal [6], God
-- of War [3578] and God of War [1062], four games called Sonic the Hedgehog -- and
-- those already collided on `match_title` before any spaces were removed, so this
-- migration does not create them. Collisions squashing genuinely DOES create are
-- 2-row, obscure, and headed by Crackdown [101] against Crack Down [10]. Ambiguity
-- at that level is what the confirm step exists for; it is not a reason to weaken
-- the rule.
--
-- ARM 5 IS GATED TO MULTI-TOKEN NEEDLES AND THAT GATE IS NOT OPTIONAL. A game
-- qualifies only when EVERY distinct token of the query is a whole word in its
-- title, or in one of its alternative titles. On one token that degenerates to
-- "return every game containing this word, scored 0.60", which would flood the
-- results and drag junk over the 0.55 threshold. With two or more it is a strong
-- claim: `zelda botw` returns exactly one row in the whole catalog, and it is
-- Breath of the Wild -- `zelda` from the title, `botw` from its alternative title,
-- neither reachable by similarity against the mixed needle.
--
-- 0.60 IS A FLOOR, NOT A SCORE, and that is what makes arm 5 safe. It enters the
-- union alongside the others and `max()` keeps whichever is larger, so a row that
-- already scored 0.867 keeps 0.867. It can only lift a row that had nothing
-- better. Verified on the live catalog: `final fantasy` matches 63 games on token
-- coverage and its top 5 is byte-identical before and after, because all five
-- score above 0.60 on similarity alone. Same for `god of war`, `mario kart`,
-- `the last of us`, `red dead redemption 2`, `resident evil 4`, `hollow knight`,
-- `super mario odyssey`, `animal crossing` and `hades 2` -- ten of ten unchanged,
-- alongside the eleven abbreviation and round-trip cases from sections 3b and 4b.
--
-- ONE DELIBERATE BEHAVIOUR CHANGE FALLS OUT OF THIS. 0.60 is above CONFIDENT, so a
-- YouTube share whose cleaned title is entirely accounted for by one game now
-- asserts `confident` where it previously did not (share-resolve line 65 tests
-- `score >= CONFIDENT` directly for youtube). That is the right answer and the
-- all-tokens rule is what makes it safe: real captions carry words like
-- "gameplay", "speedrun" and "review", and a single uncovered token disqualifies
-- the row outright. `confident` still only means "show this one large" -- the
-- confirm step is unchanged and is still required.
create or replace function shelf_search_games(q text, max_results int default 5)
returns setof shelf_catalog_row
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  needle   text := shelf_match_title(q);
  squashed text := replace(shelf_match_title(q), ' ', '');
  toks     text[];
  ntok     int;
begin
  if needle = '' then
    return;
  end if;

  -- Distinct, because `having count(distinct tok) = ntok` can never be satisfied
  -- if the needle repeats a word and ntok counts it twice.
  select array_agg(distinct t) into toks
    from unnest(string_to_array(needle, ' ')) as t
   where t <> '';
  ntok := coalesce(array_length(toks, 1), 0);

  -- The gate. An empty array makes arm 5 scan nothing rather than everything.
  if ntok < 2 then
    toks := '{}'::text[];
    ntok := 0;
  end if;

  return query
  with hits as (
    select g.id, similarity(g.match_title, needle) as score
      from games g
     where g.match_title % needle
    union all
    select a.game_id, similarity(a.match_title, needle) * 0.98
      from game_alt_titles a
     where a.match_title % needle
    union all
    -- Arms 3 and 4: the needle IS the name, bar the spaces. Btree probes.
    select g.id, 1.0::real
      from games g
     where squashed <> ''
       and replace(g.match_title, ' ', '') = squashed
    union all
    select a.game_id, 0.98::real
      from game_alt_titles a
     where squashed <> ''
       and replace(a.match_title, ' ', '') = squashed
    union all
    -- Arm 5: every token of the query accounted for by this game's names.
    -- Driven per token off the GIN indexes above, then intersected by the HAVING,
    -- so the catalog is never scanned whole.
    select x.game_id, 0.60::real
      from (
        select g.id as game_id, t.tok
          from unnest(toks) as t(tok)
          join games g
            on to_tsvector('simple', g.match_title) @@ plainto_tsquery('simple', t.tok)
        union all
        select a.game_id, t.tok
          from unnest(toks) as t(tok)
          join game_alt_titles a
            on to_tsvector('simple', a.match_title) @@ plainto_tsquery('simple', t.tok)
      ) x
     group by x.game_id
    having count(distinct x.tok) = ntok
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
   order by b.score
              + 0.15 * ln(1 + coalesce(g.total_rating_count, 0)) / ln(1 + 10000) desc,
            g.critic_score desc nulls last
   limit greatest(max_results, 1);
end;
$$;

-- Migration 000700's rule, and it bites every single time a function is replaced:
-- `create or replace` restores the default PUBLIC execute grant, and `authenticated`
-- inherits from PUBLIC, so anon silently regains execute on search. Re-issue both.
-- Check with: select proacl from pg_proc where proname = 'shelf_search_games';
revoke all on function shelf_search_games(text, int) from public, anon;
grant execute on function shelf_search_games(text, int) to authenticated;
