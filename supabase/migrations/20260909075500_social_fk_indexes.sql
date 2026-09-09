-- The same linter rule migration 000800 exists for, applied to the social tables.
--
-- `post_likes` is keyed (post_id, user_id), which covers lookups by post -- the feed's
-- like_count and liked_by_me -- but leaves the reverse direction unindexed. That is the
-- direction a cascade takes when an account is deleted, and the one "everything this
-- person liked" would take.
--
-- `content_reports.reporter_id` is what its RLS policy filters on, so every read of a
-- reporter's own reports scans without it.
create index content_reports_reporter on content_reports (reporter_id);
create index post_likes_user on post_likes (user_id);
