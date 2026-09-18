-- Clears time-to-beat triples that contradict themselves.
--
-- FOUND FROM A SCREENSHOT, not from a test: on 18 Sep 2026 the live game detail
-- screen for Grand Theft Auto: Vice City read "135h to beat". Vice City is a ~30h
-- game. The row says so itself —
--
--   ttb_hastily 876.0   ttb_normally 134.6   ttb_completely 181.8   ttb_count 13
--
-- `hastily` larger than `completely` is not a long game, it is a broken row. The
-- three columns are the same quantity measured three ways, so
-- `hastily <= normally <= completely` is a property they must have.
--
-- The existing guard in _shared/mapping.ts (TTB_MAX_PLAUSIBLE_HOURS = 1000) is doing
-- its job — it exists because values >= 10000 overflow numeric(5,1) and killed a
-- whole 500-row seed page. It only catches the absurd. 876 < 1000, so Vice City
-- passed it and reached a user.
--
-- The matching guard now lives in mapping.ts as guardTtbOrder(), so future seeds are
-- clean. THIS MIGRATION IS THE BACKFILL for rows already written — the two must move
-- together or a re-seed would silently restore what this deletes. The tolerance below
-- (1.25) is the same constant; if it is tuned in mapping.ts, this file no longer
-- describes the catalog. See TTB_ORDER_TOLERANCE for why 25% and not a strict `<=`:
-- most violations are crowd medians disagreeing in the last digit (Wolfenstein: The
-- New Order reports hastily 13.0 against normally 12.2 off 24 submissions) and those
-- rows are fine.
--
-- MEASURED against the live catalog the same day, over the 5,994 rows carrying any
-- time-to-beat: 298 break the ordering at all, 153 break it by more than 25%. This
-- clears those 153. It keeps GTA: San Andreas (1.083), GTA IV (1.094), Call of Duty 4
-- (1.033), Metro 2033 (1.029) and The Last of Us Part I (1.026); it clears Vice City
-- (6.508), Overwatch (32.420), Super Mario Bros. (5.905), Fallout 2 (2.600), Crysis
-- (2.196) and Metal Gear Solid (1.803).
--
-- WHY ALL FOUR COLUMNS AND NOT JUST THE OUTLIER. Vice City's `hastily` is the obvious
-- offender and `normally`/`completely` are self-consistent with each other — but
-- `normally` is 134.6 for a 30-hour game, so clearing only `hastily` would leave the
-- exact number on screen that started this. Nothing in the row distinguishes the one
-- bad submission from the rest. `ttb_count` goes too: a submission count standing
-- beside three NULLs describes evidence that is no longer there.
--
-- NOT ADDRESSED HERE: 57.7% of the catalog's `normally` values (2,947 of 5,106)
-- rest on a SINGLE submission and 84.0% on three or fewer, shown to the user with no
-- sample size beside it. That is a product
-- decision for Paul, not a data-quality fix. docs/research/quick-view-card.md §7.

-- One pass, so `worst` is computed once. A pair is only compared when both sides are
-- present -- a missing `completely` is the normal case, not a contradiction -- and a
-- non-positive denominator is treated as contradictory rather than divided by.
with scored as (
  select
    g.id,
    g.session_fit,
    g.genres,
    greatest(
      case
        when g.ttb_hastily_hours is null or g.ttb_normally_hours is null then 0
        when g.ttb_normally_hours <= 0 then 'Infinity'::numeric
        else g.ttb_hastily_hours / g.ttb_normally_hours
      end,
      case
        when g.ttb_normally_hours is null or g.ttb_completely_hours is null then 0
        when g.ttb_completely_hours <= 0 then 'Infinity'::numeric
        else g.ttb_normally_hours / g.ttb_completely_hours
      end,
      case
        when g.ttb_hastily_hours is null or g.ttb_completely_hours is null then 0
        when g.ttb_completely_hours <= 0 then 'Infinity'::numeric
        else g.ttb_hastily_hours / g.ttb_completely_hours
      end
    ) as worst
  from games g
  where g.ttb_hastily_hours is not null
     or g.ttb_normally_hours is not null
     or g.ttb_completely_hours is not null
),
contradictory as (
  select * from scored where worst > 1.25
)
update games g
set ttb_hastily_hours    = null,
    ttb_normally_hours   = null,
    ttb_completely_hours = null,
    ttb_count            = null,
    -- session_fit is derived at seed time by deriveSessionFit(), which reads
    -- ttbNormallyHours in exactly ONE branch: a long-form genre plus > 20h means
    -- "low". Clearing the hours invalidates only that branch, so only rows that took
    -- it can change, and they can only change to 'medium'.
    --
    -- The three conditions below reconstruct that branch from what the database
    -- stores. `session_fit = 'low'` is doing more work than it looks: 'low' is
    -- reachable only from the long-form rule or from a LOW_GENRES hit, and the
    -- HIGH checks (high genres, roguelike-ish keywords, battle-royale mode) all run
    -- BEFORE it and return 'high'. So a row already marked 'low' is proof that none
    -- of the earlier branches fired -- which matters, because `game_modes` is read
    -- by deriveSessionFit but is not a column here and cannot be re-checked in SQL.
    -- Without that proof this update could silently demote a battle-royale game.
    --
    -- Genre names are stored with IGDB's own casing ("Role-playing (RPG)",
    -- "Point-and-click"); deriveSessionFit lowercases before comparing, so this must
    -- too. 5 rows change, measured before writing this.
    session_fit = case
      when g.session_fit = 'low'
       and exists (
         select 1 from unnest(g.genres) genre
         where lower(genre) in ('adventure', 'visual novel', 'point-and-click')
       )
       and not exists (
         select 1 from unnest(g.genres) genre
         where lower(genre) in (
           'role-playing (rpg)', 'strategy', 'simulator',
           'turn-based strategy (tbs)', 'real time strategy (rts)', 'mmorpg'
         )
       )
      then 'medium'
      else g.session_fit
    end
from contradictory c
where g.id = c.id;

comment on column games.ttb_normally_hours is
  'IGDB crowd median, hours. NULL means "not known", which covers three cases: IGDB '
  'has no entry, the reading exceeded TTB_MAX_PLAUSIBLE_HOURS, or the hastily/'
  'normally/completely triple contradicted itself by more than 25% and all three were '
  'cleared (20260918110000). A present value can still rest on one submission -- check '
  'ttb_count before presenting it as fact.';
