-- Corrects `platforms.family`, which the Device Type pill on the search screen
-- (Prysm - Search, p4) filters on.
--
-- `family` was derived in scripts/seed-platforms.ts by matching the IGDB slug
-- against a regex, and its own comment says it "only has to be good enough to
-- group the roulette's platform picker". It is not good enough for a user-facing
-- filter, and the gaps are not cosmetic:
--
--   Xbox Series X|S has slug `series-x-s`, which matches none of /xbox|xseriesx|
--   xboxone/. The current-generation Xbox -- 4,035 catalog rows -- was filed
--   under no family at all. Filtering by Xbox silently dropped every game that
--   shipped on Series X|S and not on Xbox One.
--
-- Measured on the live catalog, distinct games reachable per pill:
--
--   xbox        6,228 -> 7,711  (+1,483)   Series X|S
--   nintendo   13,630 -> 14,580   (+950)   GameCube, DS, Game Boy, Famicom line
--   mobile      5,433 ->  5,482    (+49)   BlackBerry, N-Gage, Palm, Zeebo, Windows Phone
--   pc         73,627 -> 73,585    (-42)   Windows Phone/Mobile move to `mobile`
--   playstation 12,171 -> 12,171     (0)   already complete
--
-- The Xbox gain is smaller than Series X|S's 4,035 rows because most of those
-- games also shipped on Xbox One and were already reachable.
--
-- ASSIGNED BY IGDB PLATFORM ID, NOT BY SLUG. The ids are IGDB's own and are the
-- primary key here precisely because they are stable (spec 3); slugs are the
-- thing that drifted. seed-platforms.ts is updated to use the same id sets, so a
-- re-seed no longer undoes this.
--
-- Retro and VR platforms that belong to no pill stay NULL on purpose: Sega,
-- Atari, Commodore, Amiga, Neo Geo, arcade, MSX, Meta Quest, Oculus, Stadia and
-- Web browser have no home among PlayStation / Xbox / Nintendo / PC / Mobile.
-- 4,094 catalog rows reach no pill at all and are invisible to a Device Type
-- filter; that is correct, not a gap to close.

update platforms set family = 'xbox'     where id in (169);
update platforms set family = 'nintendo' where id in (21, 20, 58, 33, 22, 306, 416, 87, 307);
update platforms set family = 'mobile'   where id in (73, 42, 417, 44, 240, 74, 405);

-- The pill filter reads family, so index it alongside the join column.
create index if not exists platforms_family on platforms (family) where family is not null;
