-- shelf_ground_titles: confirm a batch of model-produced titles against the real
-- catalog in one round trip, instead of five serial shelf_search_games calls.
--
-- This is the grounding step for vague search (docs/research/semantic-search.md
-- §8 step 3): an LLM names up to five candidate games from a half-remembered
-- description, and nothing it names is ever shown to a user until this function
-- confirms it against a real catalog row. A title the catalog cannot resolve
-- simply drops out -- the whole hallucination defence is one function call.
--
-- Built and measured live via execute_sql on 16 Sep 2026 (scratch, not migrated):
-- shelf_search_games costs 0.5-1.2s per call and is built for a human typing a
-- fragment (five union arms, an alt-title join, a token-coverage arm, filters, a
-- popularity-weighted sort). Grounding five titles serially through it put 5.5s on
-- top of a ~25s model call. This function does the same five titles in 1.07s,
-- using only the two arms grounding actually needs: an exact-name match (bar
-- spacing/punctuation) and a trigram fallback for a near-exact title ("Hylics 2"
-- for "Hylics", a subtitle dropped, a colon moved). No popularity weighting, no
-- token-coverage arm -- the model already named the game, so this is confirmation,
-- not fuzzy search.
--
-- Promoted into a real migration now so a `db reset` does not silently lose it.
create or replace function shelf_ground_titles(titles text[], per int default 1)
returns table(needle text, rank int, game_id uuid, title text, score real)
language sql
stable
set search_path = public, extensions
as $$
  select t.needle, r.rank, r.id, r.title, r.score
    from unnest(titles) with ordinality as t(needle, ord)
    cross join lateral (
      select c.id, c.title, c.score,
             (row_number() over (order by c.score desc,
                                 coalesce(c.total_rating_count,0) desc, c.id))::int as rank
        from (
          -- Arm 1: the needle IS the name, bar spacing and punctuation. Btree.
          select g.id, g.title, g.total_rating_count, 1.0::real as score
            from games g
           where replace(g.match_title,' ','') = replace(shelf_match_title(t.needle),' ','')
          union all
          -- Arm 2: same, through an alternate title, very slightly discounted.
          select g.id, g.title, g.total_rating_count, 0.98::real
            from game_alt_titles a join games g on g.id = a.game_id
           where replace(a.match_title,' ','') = replace(shelf_match_title(t.needle),' ','')
          union all
          -- Arm 3: trigram fallback, only for when the model's title is close but
          -- not exact (a subtitle dropped, a colon moved).
          select g.id, g.title, g.total_rating_count,
                 similarity(g.match_title, shelf_match_title(t.needle))
            from games g
           where g.match_title % shelf_match_title(t.needle)
        ) c
       order by c.score desc, coalesce(c.total_rating_count,0) desc, c.id
       limit greatest(per,1)
    ) r
   order by t.ord, r.rank;
$$;

-- create or replace restores the default PUBLIC execute grant, and anon inherits
-- from PUBLIC -- confirmed live: anon still holds it from creation via execute_sql.
-- Re-issue both every time this function is replaced (same rule as
-- shelf_search_games, migration 000700).
revoke all on function shelf_ground_titles(text[], int) from public, anon;
grant execute on function shelf_ground_titles(text[], int) to authenticated;
