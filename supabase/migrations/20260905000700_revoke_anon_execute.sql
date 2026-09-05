-- Actually revoke EXECUTE from anon. Migration 000500 tried to, and did not.
--
-- `revoke all on function ... from public` removes only the implicit PUBLIC grant.
-- Supabase ships a default-privileges rule --
--   alter default privileges in schema public grant all on functions
--     to anon, authenticated, service_role
-- -- so every function created in `public` also gets an EXPLICIT grant to anon.
-- An explicit grant is not a PUBLIC grant, so the revoke slid straight past it and
-- proacl still read {... anon=X/postgres ...}. Verified in psql, not assumed.
--
-- Nothing was exposed by this: both functions are SECURITY INVOKER, so an anon
-- caller hits RLS and gets zero rows, and shelf_roulette additionally compares its
-- argument to auth.uid(), which is null for anon. This closes the gap between what
-- migration 000500 said it did and what the catalog actually contained.
revoke all on function shelf_search_games(text, int)            from anon;
revoke all on function shelf_roulette(uuid, int, text, numeric) from anon;

-- The normalizer is a pure text function and leaks nothing, but the app never calls
-- it directly either -- it is reached through shelf_search_games. No reason for anon.
revoke all on function shelf_match_title(text)      from anon;
revoke all on function shelf_roman_to_digits(text)  from anon;

-- Two separate grants have to go, and missing either leaves anon with EXECUTE:
--   1. the explicit anon=X grant from Supabase's default privileges (above)
--   2. the implicit PUBLIC grant Postgres puts on every new function (=X in proacl)
-- Migration 000500 revoked PUBLIC on search/roulette only, so these three kept it.
revoke all on function shelf_match_title(text)          from public;
revoke all on function shelf_roman_to_digits(text)      from public;
revoke all on function shelf_games_set_match_title()    from public, anon;

-- The trigger function is invoked by the trigger, which runs as the table owner,
-- so removing every caller grant does not affect inserts into games.
grant execute on function shelf_match_title(text)     to authenticated;
grant execute on function shelf_roman_to_digits(text) to authenticated;
