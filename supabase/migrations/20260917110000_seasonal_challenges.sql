-- Seasonal Challenge Tracker. Session A of the Events screen build (decision taken
-- 17 Sep 2026, research/events-screen.md §4) -- team-authored, hand-written per
-- season. No creation UI, no admin endpoint, no moderation surface: a challenge is
-- authored by inserting a row directly (see scripts/seed-challenges.ts for the
-- season-one example). That answers Sola's "who authors a challenge" question for
-- season one without committing to user-authored challenges, and it is reversible.
--
-- ---------------------------------------------------------------------------
-- 1. Settling the source of truth: status = 'beaten' vs finished_at is not null
-- ---------------------------------------------------------------------------
-- research/events-screen.md measured the live data disagreeing with itself: 19
-- library rows, 0 'beaten', but 2 carrying a finished_at. A progress query needs
-- BOTH signals -- status for "did they finish it" (the deliberate, user-visible
-- action) and finished_at for "when" (required to bound it to a challenge window)
-- -- so leaving them free to drift is not an option once anything reads finished_at
-- for the first time. This is the first thing that does.
--
-- Decision: status is authoritative, finished_at is a timestamp attached to it.
-- Enforced going forward by trigger; the two existing disagreeing rows are
-- reconciled below by clearing finished_at, not by forcing status to 'beaten' --
-- status is the field the user deliberately set via the UI, finished_at is
-- currently a write-only column the app cannot even read back (LIBRARY_COLUMNS in
-- remoteLibrary.ts omits it, technical-notes-for-sola.md §7), so it is the weaker
-- signal of the two and the one that yields.
create or replace function shelf_library_finished_at_sync()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'beaten' then
    if new.finished_at is null then
      new.finished_at := now();
    end if;
  else
    new.finished_at := null;
  end if;
  return new;
end;
$$;

create trigger library_entries_finished_at_sync
  before insert or update of status, finished_at on library_entries
  for each row execute function shelf_library_finished_at_sync();

-- Reconcile the two rows research/events-screen.md found live. Nothing else in the
-- catalog is 'beaten' with a null finished_at, so there is no other direction to fix.
update library_entries
   set finished_at = null
 where status <> 'beaten'
   and finished_at is not null;

-- ---------------------------------------------------------------------------
-- 2. The challenges themselves
-- ---------------------------------------------------------------------------
-- criteria shape: {"genres": ["Role-playing (RPG)"], "count": 3} -- genres is an
-- array (matched with &&, any-of) rather than a single string so "Beat 3 RPGs OR
-- Shooters" is representable without a schema change; a single-genre challenge like
-- Sola's "October Horror Challenge" example is just a one-element array.
--
-- research/events-screen.md's caution carries forward: 'Indie' matches 56% of the
-- catalog (51,512 of 91,806 games), so an "Indie challenge" is not a filter. This
-- migration cannot enforce that judgement call -- the check constraint below only
-- guards shape, not which genre someone picks.
create table seasonal_challenges (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  description text not null default '',
  start_date  date not null,
  end_date    date not null,
  criteria    jsonb not null,
  created_at  timestamptz not null default now(),
  -- Lets scripts/seed-challenges.ts upsert instead of needing to check-then-insert,
  -- same reason every seed table in this repo has an onConflict target.
  unique (title, start_date),
  check (end_date >= start_date),
  -- A CHECK only rejects an expression that evaluates to FALSE, and a missing key
  -- makes `criteria->'genres'` SQL NULL, which makes every comparison below NULL
  -- rather than FALSE -- so without the `?` existence checks first, a criteria of
  -- `{}` would PASS this constraint. Caught in review before this shipped, not
  -- after: worth remembering next to release_tbd, another column whose absence
  -- of a value was silently mistaken for "checked and fine".
  check (
    (criteria ? 'genres') and (criteria ? 'count')
    and jsonb_typeof(criteria->'genres') = 'array'
    and jsonb_array_length(criteria->'genres') > 0
    and jsonb_typeof(criteria->'count') = 'number'
    and (criteria->>'count')::int > 0
  )
);

-- Catalog-shaped reference data, same access model as games/platforms (000300):
-- readable by any signed-in user, writable only by the service role. No insert/
-- update/delete policy is the "no creation UI, no admin endpoint" decision made
-- physical -- a season is authored by a service-role script, nothing else can write
-- one.
alter table seasonal_challenges enable row level security;

create policy "challenges readable by authenticated"
  on seasonal_challenges for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- 3. Reading challenges with the caller's progress
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER (the default): RLS on both tables already scopes this to rows
-- the caller may see and to their own library_entries, same belt-and-suspenders
-- reasoning as shelf_recently_viewed (20260915140000).
--
-- Returns every challenge, not just active/upcoming ones -- Sola's UI shows
-- active/upcoming, but that is a presentation choice for the app to make, the same
-- way shelf_recently_viewed returns rows and lets the caller decide how to render
-- them. `status` is computed here so the app does not reimplement the date math.
--
-- my_progress.count only counts finished_at within [start_date, end_date] AND
-- status = 'beaten' -- both, per §1. A game beaten before the trigger above existed
-- and left with a null finished_at (there are none today, per the reconciliation
-- above, but a future direct SQL write could still do it) counts for nothing,
-- deliberately: with no timestamp there is no way to know it belongs in this window.
create or replace function shelf_challenges()
returns table (
  id          uuid,
  title       text,
  description text,
  start_date  date,
  end_date    date,
  criteria    jsonb,
  status      text,
  my_progress jsonb
)
language sql
stable
set search_path = public
as $$
  select c.id, c.title, c.description, c.start_date, c.end_date, c.criteria,
         case
           when c.end_date   < current_date then 'ended'
           when c.start_date > current_date then 'upcoming'
           else 'active'
         end,
         jsonb_build_object(
           'count', (
             select count(*)
               from library_entries le
               join games g on g.id = le.game_id
              where le.user_id = (select auth.uid())
                and le.status = 'beaten'
                and le.finished_at is not null
                and le.finished_at::date between c.start_date and c.end_date
                and g.genres && array(select jsonb_array_elements_text(c.criteria->'genres'))
           ),
           'target', (c.criteria->>'count')::int
         )
    from seasonal_challenges c
   order by
     case
       when c.end_date   < current_date then 2
       when c.start_date > current_date then 1
       else 0
     end,
     c.start_date;
$$;

comment on function shelf_challenges() is
  'Every seasonal challenge with status (active/upcoming/ended) and the caller''s progress against it. Anon gets every challenge with progress.count always 0 (auth.uid() is null), but has no EXECUTE grant regardless.';

revoke all on function shelf_challenges() from anon, public;
grant execute on function shelf_challenges() to authenticated;
