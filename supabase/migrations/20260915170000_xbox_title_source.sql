-- Widens game_external_ids.source to admit 'xbox_title': the output of the
-- DisplayCatalog bridge (scripts/link-lab/xbox-title-bridge.ts --write), measured
-- in docs/research/account-linking.md §4a at 62.9% of a played library.
--
-- DELIBERATELY A DIFFERENT VALUE FROM 'xbox' (the import source in library_entries
-- and platform_accounts). 'microsoft' rows already in this table are Microsoft
-- Store product ids -- the LEFT-HAND side of the bridge, not something an import
-- can resolve against directly (see the comment on the original table). 'xbox_title'
-- rows are the bridge's OUTPUT: real Xbox Live title ids, exactly what OpenXBL's
-- titleHistory endpoint returns per game, which is what an Xbox import actually
-- resolves against. Keeping the two apart means a bug that writes to the wrong
-- one fails loudly (a resolve against an empty source) rather than silently
-- resolving against Microsoft Store ids that were never meant to be joined on.
alter table game_external_ids drop constraint game_external_ids_source_check;
alter table game_external_ids add constraint game_external_ids_source_check
  check (source in ('steam','microsoft','android','xbox_title'));
