-- The social graph: profiles, follows, blocks.
--
-- This is the first time one user's rows are legitimately readable by another. Every
-- policy written before this one is strict owner-only isolation, and `verify:auth`
-- asserts exactly that, so the boundary is drawn deliberately here:
--
--   PUBLIC to any signed-in user   profiles, follows, and (next migration) posts,
--                                  likes and comments -- things a person chose to publish
--   STILL OWNER-ONLY               library_entries, share_intake
--
-- A shelf is not a feed. Nothing in this migration or the next one exposes what a user
-- has in their library, what they shared, or what the roulette rolled for them. The
-- feed carries only what someone deliberately posted. If that ever changes, it is a
-- decision to be taken on purpose, not by widening a policy here.
--
-- FOLLOW, NOT FRIENDSHIP -- decided 8 Sep 2026 with the app's built UI in hand. The
-- Friends tab already renders follower/following counts, which assume asymmetry, and a
-- confirmation step would need two devices to demo. So: A follows B needs nothing from
-- B, and the pair is the primary key, which makes a duplicate follow a no-op rather
-- than a second row.

-- Handles and display names, because the feed renders "Paul Elite @paulelite" and an
-- avatar, and auth.users carries none of that. One row per account, created by the app
-- on first sign-in.
create table profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- Stored lowercase so "@Paul" and "@paul" cannot both exist. The app may display it
  -- however it likes; uniqueness is decided here, not in the client.
  handle       text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 40),
  -- Same palette the covers use, for the same reason: the app resolves an unknown key
  -- to grey and reports no error, so the backend must only ever emit keys it can render.
  -- See the colorKey drift in docs/technical-notes-for-sola.md.
  avatar_color text not null default 'slate'
                 check (avatar_color in ('teal','orange','purple','pink','gold',
                                         'navy','red','green','blue','slate')),
  bio          text not null default '' check (length(bio) <= 160),
  created_at   timestamptz not null default now()
);

create table follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint no_self_follow check (follower_id <> followee_id)
);

-- The primary key already covers (follower_id, ...), so only the reverse direction
-- needs its own index -- and it is the one the follower COUNT reads.
create index follows_followee on follows (followee_id);

-- Blocking is not a nicety here. The next migration opens user-authored text to every
-- signed-in account, and an app that ships user-generated content without a way to
-- block and report the people producing it does not pass App Store review (guideline
-- 1.2). Blocks are enforced in the policies on posts and comments, not just in the UI.
create table user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint no_self_block check (blocker_id <> blocked_id)
);

create index user_blocks_blocked on user_blocks (blocked_id);

alter table profiles    enable row level security;
alter table follows     enable row level security;
alter table user_blocks enable row level security;

-- Profiles are the directory: you cannot follow someone you cannot find, and the feed
-- cannot render an author it cannot read. Nothing sensitive lives here -- no email, no
-- library, no share history.
create policy "profiles readable by authenticated"
  on profiles for select to authenticated using (true);
create policy "own profile insert"
  on profiles for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy "own profile update"
  on profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Follower and following counts are public in the design, so the edges are readable.
-- Only the follower may create or remove their own edge -- you cannot make someone
-- follow you, and you cannot remove someone else's follow.
create policy "follows readable by authenticated"
  on follows for select to authenticated using (true);
create policy "own follows insert"
  on follows for insert to authenticated
  with check (follower_id = (select auth.uid()));
create policy "own follows delete"
  on follows for delete to authenticated
  using (follower_id = (select auth.uid()));

-- A block list is private to the person who made it. Revealing it would tell the
-- blocked person they were blocked, which is exactly what a block is meant not to do.
create policy "own blocks"
  on user_blocks for all to authenticated
  using (blocker_id = (select auth.uid()))
  with check (blocker_id = (select auth.uid()));

-- Is there a block in either direction between the viewer and this author? Used by the
-- policies in the next migration. SECURITY DEFINER because a viewer must not be able to
-- read the other person's block list directly, but the check itself has to see both.
create or replace function shelf_blocked_between(p_viewer uuid, p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from user_blocks b
     where (b.blocker_id = p_viewer and b.blocked_id = p_author)
        or (b.blocker_id = p_author and b.blocked_id = p_viewer)
  );
$$;

-- Migration 000700's rule: a new function gets Supabase's default grants, which include
-- EXECUTE for anon. Revoke first, then grant. This one is SECURITY DEFINER, so leaving
-- anon with execute would hand an unauthenticated caller a block-list oracle.
revoke all on function shelf_blocked_between(uuid, uuid) from public, anon;
grant execute on function shelf_blocked_between(uuid, uuid) to authenticated;
