-- Covering indexes for the three foreign keys that lacked one, flagged by the
-- Supabase performance linter (0001_unindexed_foreign_keys).
--
-- These are on the small per-user tables, not the catalog, so the storage cost is
-- negligible against the free plan's 500 MB -- unlike anything on `games`.
--
-- The one that actually bites is library_entries.game_id: without it, deleting or
-- re-seeding a catalog row forces a sequential scan of library_entries to check the
-- reference, and the seed is expected to rewrite the catalog more than once.
create index if not exists library_entries_game_id     on library_entries (game_id);
create index if not exists library_entries_platform_id on library_entries (platform_id);
create index if not exists share_intake_matched_game   on share_intake (matched_game_id);

-- Deliberately NOT addressing the linter's "unused index" notices for games_ttb and
-- games_session_fit. Those read as unused because the catalog is empty and no query
-- has run yet; both back the roulette's size-bucket and session-fit ordering. Revisit
-- after the seed and some real traffic, not now.
