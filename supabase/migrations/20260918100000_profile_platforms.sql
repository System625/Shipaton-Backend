-- Onboarding step 4, "Where do you play on?" -- a multi-select the app currently
-- saves on-device only. Sola's ask (task.md, 16 Sep): one column, no join table,
-- reusing the exact five values /search's `device` param already accepts.

alter table profiles
  add column platforms text[] not null default '{}';

-- Same five values as /search's `device` param -- verified identical to DEVICE_TYPES
-- in supabase/functions/search/index.ts:24, and to the non-null `family` values in
-- `platforms` (nintendo, pc, mobile, playstation, xbox). Reusing them means the
-- preference can be handed straight to a search filter with no mapping table between.
alter table profiles
  add constraint platforms_valid check (
    platforms <@ array['playstation','xbox','nintendo','pc','mobile']
    and cardinality(platforms) <= 5
  );

-- No policy change: the own-profile UPDATE policy from 20260908213000 is row-level
-- with no column list, and the table-level grant on `profiles` covers a column added
-- later automatically. The client's existing `.update({ platforms })` starts working
-- the moment this migration lands. Verified in scripts/verify-onboarding.ts rather
-- than assumed.
