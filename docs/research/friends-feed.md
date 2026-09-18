# The Friends feed — what `task.md` asks for, and what is actually left

Researched 18 September 2026 against the live project (`sbunhrxwhraigwpidbxk`) and
against the app repo at its real HEAD (`akintewe/revenue-cat-game`, `f1c4bfa`,
18 Sep, *"Merge origin/main: keep the database-backed Friends feed, add the composer
extras"*). This is the reasoning and the evidence. The build plan is §6 onward.

**The headline, and the reason this document exists: `task.md` is stale, and
building it as written would break the live app.** Roughly 70% of what it asks for
already shipped — undeclared, from outside this repo — and was declared in
`20260918120000_declare_live_social_schema.sql` a few hours before that note was
read. The remaining 30% is real, and it is not the 30% the note's "suggested order"
puts first.

---

## 1. How `task.md` was checked

Three independent sources, because the note's own file paths already disagreed with
the app (`src/features/library/components/PostCategoryPill.tsx` in the note;
`src/features/feed/components/CategoryChip.tsx` in the repo):

1. **The live schema**, read from PostgREST's OpenAPI document
   (`GET /rest/v1/` with the service key) — every table and column, and every
   `/rpc/shelf_*` the project exposes.
2. **The live behaviour**, driven through real JWTs with the repo's own harness
   (`scripts/social-accounts.ts`, the same throwaway-account pattern
   `verify:social` uses). Four probes: create a post with a poll and read it back
   through `shelf_feed`; vote, re-vote, vote across polls and vote after close;
   insert a `post_repost` notification to see whether the kind is accepted; and post
   with a game attached, to confirm the projection's joins and the grants a view over
   them would need. Accounts were deleted after each run.
3. **The app repo at HEAD**, cloned and read — `src/services/social/feed.ts`,
   `notifications.ts`, `ComposePostScreen.tsx`, `usePostHandlers.ts`,
   `NotificationsScreen.tsx`, `RichText.tsx`.

Nothing below is inferred from the note.

## 2. What `task.md` asks for versus what is live

| `task.md` asks | Live today | Verdict |
|---|---|---|
| §2 add `posts.category` | Column exists, check-constrained to the same three values, returned by `shelf_feed`; probe round-tripped `questions` | **Done** |
| §3 `polls`/`poll_options`/`poll_votes` tables | `post_polls` / `post_poll_options` / `post_poll_votes`, keyed by `post_id`, composite FK proving an option belongs to its poll | **Done, different names** |
| §3 poll shape `{options[], ends_at, my_vote_id}` | `{ends_at, total_votes, my_option_id, options:[{id,label,votes,voters[]}]}` via `shelf_poll()` | **Done — and the app reads `my_option_id`** |
| §3 `votePoll(pollOptionId)` | `shelf_vote_poll(p_post_id, p_option_id)`; app calls it with both | **Done** |
| §3 "one vote, cannot change it" | Vote **can** be moved (`on conflict do update`); app ships `moveVote()` and relies on it | **Deliberately not what the note says** |
| §3 reject votes after `ends_at` | Enforced in RLS, not app code. Probe: `42501` after close, for a new voter and for a re-voter alike | **Done, verified** |
| §3 attach poll atomically at create | `shelf_create_post(p_body, p_category, p_game_id, p_image_path, p_link_url, p_poll_options, p_poll_hours)`; app calls exactly this | **Done** |
| §4 `post_reposts` + counts + `reposted_by_me` | Table, RLS, `repost_count`, `reposted_by_me` all live; app inserts/deletes straight through PostgREST | **Done** |
| §4 "decide whether reposts inject into the feed" | **Already decided in code**: `shelf_feed` has a `reposts` CTE, `reposted_by_handle`/`reposted_by_name` and `reason = 'repost'`; `PostCard.tsx:38` renders "X reposted" | **Done — the open question is closed** |
| §4 `post_repost` notification kind | `notifications_kind_check` is `('follow','post_like','post_comment','game_release')`. Probe: insert rejected `23514`. A real repost creates **0** notifications | **MISSING** |
| §5 `posts.visibility` + feed filtering | No column (`42703: column posts.visibility does not exist`). No filtering anywhere | **MISSING** |
| §6 mentions | App resolves `@handle` at compose time and renders them tappable (`RichText.tsx`). No `post_mentions`, no `post_mention` kind | **Partly client-side; notification missing** |
| §7 share needs no backend | `post_shares` exists, `share_count` is in the feed, and the app **writes** it on every native share | **Note is wrong; already built** |
| §8 "the client will pick these up automatically" | Already picked up. `FeedPost` types all 29 columns the live `shelf_feed` returns | **Superseded** |

**The dangerous rows are the ones marked "different".** A literal implementation of
§3 would rename the poll tables, rename `my_option_id` to `my_vote_id`, and forbid
changing a vote — three changes that each independently break a shipped app screen.

### 2a. The 29 columns `shelf_feed` actually returns (probe output, verbatim)

```
id, body, link_url, image_path, created_at, edited_at, author_id, handle,
display_name, avatar_color, category, game_id, game_title, game_cover,
game_artwork, game_year, game_genres, game_rating, game_platforms, poll,
like_count, comment_count, repost_count, share_count, liked_by_me,
reposted_by_me, reposted_by_handle, reposted_by_name, reason
```

`poll`, live, for a two-option poll:

```json
{"ends_at":"2026-09-19T19:08:15.184621+00:00","total_votes":0,"my_option_id":null,
 "options":[{"id":"51ae…","label":"one","votes":0,"voters":[]},
            {"id":"7cc5…","label":"two","votes":0,"voters":[]}]}
```

### 2b. The polls subsystem, exercised end to end

| Check | Result |
|---|---|
| `shelf_create_post` with 3 options | post id returned, options written in order |
| vote | `total_votes=1`, `my_option_id` set |
| vote again for a different option | **allowed**, still `total_votes=1` |
| vote using an option id from another poll | rejected `23503` (composite FK does its job) |
| vote after `ends_at` moved into the past | rejected `42501` (RLS, as the migration claims) |

Nothing in §3 of `task.md` needs building. It needs *not* building.

### 2c. This is not a feature running on an empty table

Counted live, 18 Sep, which matters for every judgement below — none of this is
being designed against a hypothetical:

```
profiles  33      posts          68      post_polls       4
follows  389      post_reposts   24      post_poll_votes 61
                  post_shares   292
```

**Twenty-four reposts have already happened and notified nobody.** Sixty-one poll
votes have been cast against four polls. The feed has real content in it; the gaps
below are gaps in a system people are using, not in a stub.

## 3. What is actually left

Four items. Two of them needed a product call first; both are settled in §7.

1. **`post_repost` notifications** — the only thing in `task.md` §4 that is genuinely
   missing. Reposting is silent today.
2. **`posts.visibility`** — the whole of §5, unbuilt, and with a client that has no
   audience control at all any more (see §4).
3. **`shelf_post(p_post_id)`** — *not in `task.md`*, but asked for in the app's own
   source, in a comment addressed to us (see §5). Highest ratio of value to risk in
   the list.
4. **Mention notifications** — §6, and smaller than the note assumes because the
   app already resolves and links handles itself.

## 4. The "Public ⌄" pill in §5 does not exist

`task.md` describes it as decorative and asks for the backend so it can be wired.
At app HEAD the composer's toolbar is Photo, Game, Poll, Tag and a character
counter — nothing else. `grep -i "visibility|public|audience"` across `src/` returns
only Supabase config, OAuth client ids and `getPublicUrl`.

So visibility is not "wire up an existing pill". It is: a schema change, an RLS
change, a product decision about what *friends* means on a follow graph, **and** new
client UI. That is why it is sequenced after the other three, and why §7 asks for a
decision before any of it is written.

## 5. Two things the app is asking for that `task.md` never mentions

**`shelf_post(p_post_id)`.** From `src/services/social/feed.ts:72`, in the app's own
words:

> *There's no direct "fetch one post by id" endpoint yet, so this pages through an
> author's own feed looking for it. … Flagged to backend as a real gap worth closing
> (a `shelf_post(p_post_id)` RPC) rather than paging forever.*

Every tap on a like/comment notification runs `findPostById`, which calls
`shelf_feed` up to four times at 50 rows each — up to 200 fully-joined post rows,
each with its own poll subquery, to find one post. It also only works for the
caller's *own* posts, so a repost or mention notification could never open its post.

**The notification inbox will break on the first `game_release` row.** The app's
`NotificationKind` is `'follow' | 'post_like' | 'post_comment'`; live, the table also
accepts `game_release` (shipped 17 Sep) and `shelf_notifications` returns three more
columns (`game_id`, `game_title`, `game_cover_url`) the app doesn't type.
`describe()` falls through to `''` and `iconFor()` returns `undefined`, so such a row
renders as a name with no text and no icon.

Counted live, so the claim is the right size: **389 `follow`, 359 `post_like`, 84
`post_comment` and 0 `game_release` rows**. The bug is latent, not currently
visible — the release sweep is scheduled and has simply not caught a watched game's
release day yet. It is not caused by anything below, but it means **adding
`post_repost` without telling Sola would arm a second blank row type**, so the client
fix and the migration should go out together.

---

## 6. Build plan

**Do not build**, in the order `task.md` suggests them: `posts.category`, the poll
tables, `shelf_create_post`'s poll attachment, `shelf_vote_poll`, the `ends_at`
guard, `post_reposts`, `repost_count`/`reposted_by_me`, or repost feed-injection.
All eight are live and exercised by the shipped app. Renaming `my_option_id` to
`my_vote_id`, or making a vote final, would each break a screen that works today.

| Step | Migration | Also touches | Size | Risk |
|---|---|---|---|---|
| 1 `post_repost` notifications | constraint + trigger | `_shared/onesignal.ts`, `push-sweep` **redeploy** | ~60 lines | Low — additive |
| 2 `posts.visibility` | column + 4 policies + `shelf_create_post` re-create | — | ~80 lines | **Medium — RLS on the read path of every post surface** |
| 3 `private.post_cards` + `shelf_post` | view + 2 functions re-created | — | ~120 lines | **Medium — rewrites the live feed's projection; has a stop rule** |
| 4 mentions | constraint + trigger | `_shared/onesignal.ts`, `push-sweep` **redeploy** | ~50 lines | Low, but it is a new abuse surface |

Steps 1 and 4 ship together, so `push-sweep` is deployed once.
Step 2 before Step 3 is deliberate: it keeps `shelf_feed`'s drop-and-create down to
a single occurrence (§6, Step 3).

Four migrations, each with its own verification. Stamps must sort after
`20260918150000` — use the real date at build time (`20260919100000`, `…110000`, …).

Every migration in this repo follows three house rules that all four of these hit:

- **A new function gets Supabase's default grants, which include `anon`.** Revoke
  from `public, anon`, then grant to `authenticated`. This is the exact hole
  `20260918120000` found in `shelf_poll` / `shelf_create_post` / `shelf_vote_poll`.
- **A changed return type or a changed argument list means `drop` + `create`, not
  `create or replace`.** Precedent: `20260914120000`, `20260914130100`,
  `20260917130000`. Migrations run in a transaction, so there is no window where the
  app sees a missing function.
- **Never add a parameter as an overload.** Two `shelf_create_post`s differing only
  by a defaulted 8th argument leaves PostgREST to pick between candidates by body
  keys; drop the old signature and create the new one in the same migration instead.

### Step 1 — `post_repost` notifications

*Migration: `…_repost_notifications.sql`*

```sql
alter table notifications drop constraint notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('follow','post_like','post_comment','game_release','post_repost'));
```

Then a trigger in `private`, modelled line for line on
`private.shelf_notify_post_like()` (`20260909121000`):

- `security definer`, `set search_path = public` — it writes a row owned by someone
  else, which is what the missing INSERT policy on `notifications` forbids everyone
  else from doing.
- Reads the post's `author_id`; returns early if the post is gone (`author is null`)
  or if the reposter **is** the author. Self-reposting is allowed by the database
  today (verified — the insert succeeds), exactly as self-liking is; it just must not
  ring a bell, and `no_self_notification` would raise `23514` and fail the repost
  itself if it did.
- Returns early on `private.shelf_blocked_between(author, new.user_id)`.
- `insert … on conflict do nothing` against `notifications_dedupe`, which since
  `20260917130000` is `(user_id, actor_id, kind, post_id, comment_id, game_id)`
  `nulls not distinct` — so un-repost → re-repost does not notify twice, matching
  likes.
- `revoke all on function … from public, anon;` then
  `create trigger post_reposts_notify after insert on post_reposts …`.

**Then the push half, which is a code change, not a migration.** `push-sweep` reads
every unpushed row regardless of kind and renders copy from
`_shared/onesignal.ts#pushCopyFor`:

- add `case "post_repost": return { title: "New repost", body: \`${name} reposted your post\` };`
- widen the union in `pushCopyFor`'s signature **and** the cast at
  `push-sweep/index.ts:90`, which currently reads
  `as "follow" | "post_like" | "post_comment" | "game_release"`.
- **redeploy `push-sweep`** — `_shared` is bundled per function, so the migration
  alone would leave live pushes falling off the end of a `switch` that no longer
  covers every kind. (`shelf_next_push_batch` needs no change: a repost row has an
  actor, so `actor_display_name` is populated.) `push-sweep` is the only consumer of
  `pushCopyFor`, so it is the only redeploy.

Note that `npm run typecheck` will **not** catch a mistake here: `tsconfig.json`
lists six `_shared` modules and `onesignal.ts` is not among them, because edge
functions are typechecked by Deno at deploy time instead. The deploy is the check.

If reposts should ring the bell but *not* push, the one-line alternative is a
`kind <> 'post_repost'` predicate in `shelf_next_push_batch` — but that leaves rows
unpushed forever, so it would want `pushed_at = now()` written at insert instead.
**Decided: push it**, like every other kind (§7).

### Step 2 — `posts.visibility`

*Migration: `…_post_visibility.sql`. Do not touch `shelf_feed` here — see why below.*

```sql
alter table posts add column visibility text not null default 'public'
  check (visibility in ('public','friends'));
```

`not null default 'public'` means every existing row and every write from the
current app keeps behaving exactly as it does today.

**No index on `visibility`, on purpose** (this repo indexes deliberately — see
`20260905000800_fk_indexes.sql`). It is a two-value column that will be
overwhelmingly `'public'`, and it is only ever read as one branch of an `OR` beside
two point lookups on the `follows` primary key; a b-tree on it would never be
chosen. Also worth knowing before editing `shelf_feed`: its `scoped` CTE does
`select p.*`, so `visibility` silently joins that CTE — harmless, because the outer
projection names every column explicitly, but it is the kind of thing that hides a
surprise in a function this wide.

**The whole feature is one RLS policy, and that is the point.** `shelf_feed` is
`security invoker` (`language sql stable`, no `security definer`) — so the rows it
can see are the rows the caller can see. This is already proven, not assumed:
`verify-social.ts:168-176` blocks an account and asserts the blocker's post vanishes
from `shelf_feed` **and** from a direct `from('posts').select()`. Visibility rides
the same mechanism:

```sql
drop policy "posts readable unless blocked" on posts;
create policy "posts readable unless blocked" on posts for select to authenticated
using (
  not private.shelf_blocked_between((select auth.uid()), author_id)
  and (
    visibility = 'public'
    or author_id = (select auth.uid())
    or private.shelf_mutual_follow(author_id, (select auth.uid()))
  )
);
```

with a small `private.shelf_mutual_follow(uuid, uuid)` — `stable`, **invoker** (no
`definer`: `follows` is already readable by every signed-in account, so there is
nothing for `definer` to buy and a whole class of mistake it would open), two
`exists` lookups that both hit the `follows` primary key.

What that one policy buys, with no further code:

| Surface | Effect |
|---|---|
| `shelf_feed`, all five `reason` tiers | A friends-only post cannot enter `following`, `network`, `popular` or `repost` for a non-friend — every tier reads `posts` |
| `shelf_feed` with `p_handle` (profile view) | Same |
| Direct `from('posts').select()` | Filtered |
| `shelf_profile_stats.post_count` | Invoker; the count drops friends-only posts for strangers, so the number matches the list |
| `post_polls` / `post_poll_options` / `post_poll_votes` | Their policies are `exists (select 1 from posts p …)`, evaluated as the caller, so a hidden post's poll is hidden too |
| `post_reposts` (select) | Same shape, same result — B reposting A's friends-only post shows nothing to B's non-mutual followers |
| `post_shares` (select) | Same |

**Three policies must be tightened by hand**, because they do not look at `posts`:

- `"likes readable by authenticated" … using (true)` — leaks `(post_id, user_id)`
  rows for hidden posts.
- `"comments readable unless blocked"` — checks the *comment author's* block state
  only, so comments under a friends-only post stay world-readable by post id.
- `"own likes insert" … with check (user_id = auth.uid())` — the write side, and the
  odd one out: `post_reposts`, `post_shares` and `post_comments` all additionally
  require `exists (select 1 from posts p where p.id = post_id)`, which under RLS
  means you cannot write a row against a post you cannot see. `post_likes`, the
  oldest of the four, does not. **This is already a live hole** — a blocked account
  can like the post it is blocked from (the trigger suppresses the bell, but
  `like_count` still moves) — and visibility would extend it to friends-only posts
  for anyone who learns a post id.

All three take the same `and exists (select 1 from posts p where p.id = post_id)`.
No recursion risk: the `posts` policy references `follows` and `user_blocks`, never
`post_likes` or `post_comments`.

A pleasant consequence of that shape, worth knowing before writing the tests: once a
post is invisible, **reposting, sharing and commenting on it are refused at insert
with `42501`, not silently ignored**. Only `post_repost`'s notification trigger needs
its own block check, as belt-and-braces beside the like trigger's — which is
load-bearing precisely because the likes policy never had one.

**`shelf_create_post` needs `p_visibility`**, which is an argument-list change:
`drop function shelf_create_post(text, text, uuid, text, text, text[], int);` then
create it with `p_visibility text default 'public'` appended, body otherwise
verbatim, **then re-run the revoke/grant pair for the new signature**. Because every
argument has a default, the shipped app's 7-key call still resolves.

Not included on purpose: no `posts.visibility` UPDATE restriction beyond the
existing own-row policy (an author may change their mind), and no block on
reposting a friends-only post — the RLS above already contains it, and the verify
script proves containment rather than trusting it.

### Step 3 — `private.post_cards`, `shelf_post`, and one honest `shelf_feed` rewrite

*Migration: `…_post_by_id.sql`*

The projection `shelf_feed` uses — 26 of its 29 columns; only `reposted_by_handle`,
`reposted_by_name` and `reason` depend on the ranking rather than the post — has already
drifted once, badly: this repo's copy said 16 columns while live returned 29, and
`20260918120000` exists because a `create or replace` from the stale copy would have
silently deleted thirteen of them. Writing `shelf_post` as a second hand-copy of
that projection guarantees a second drift. So:

```sql
create view private.post_cards with (security_invoker = on) as
  select p.id, p.body, …, p.visibility, shelf_poll(p.id) as poll, …
    from posts p
    join profiles pr on pr.user_id = p.author_id
    left join games g on g.id = p.game_id;

revoke all on private.post_cards from public, anon;
grant select on private.post_cards to authenticated;
```

Two details in that snippet are both load-bearing.

**`security_invoker = on`** (Postgres 15+; this project is 17.6). A view defaults to
running as its *owner*, which would hand every caller every post and undo Step 2
completely. The advisors report it as `security_definer_view` if it is forgotten,
which is one more reason to run them (§8). Invoker also means the caller needs real
SELECT on everything the view touches — verified live: an ordinary signed-in account
can already read `posts`, `profiles`, `games`, `game_platforms` and `platforms`, and
a feed row for a post with a game comes back complete (`game_platforms`
`["nintendo","pc","playstation"]`, four genres, `game_rating 3.9`).

**`private`, not `public`.** Everything in `public` is a public API: PostgREST
exposes tables and views there exactly as it exposes functions, so a `public`
`post_cards` would appear at `/rest/v1/post_cards` as a new, arbitrarily filterable
and sortable read surface — and `authenticated` *must* hold SELECT on it for the
invoker functions to work, so it could not simply be revoked. `private` is the same
answer `20260908214500` reached for `shelf_blocked_between`, for the same reason;
`authenticated` already has USAGE on that schema. RLS and `security_invoker` behave
identically there.

Then both functions are drop-and-create over the view: `shelf_feed` keeps its
`me`/`following`/`network`/`reposts`/`popular`/`scoped` CTEs and its ranking
verbatim, joining `private.post_cards` for the projection and adding the three
caller-context columns (`reposted_by_handle`, `reposted_by_name`, `reason`) that are
not intrinsic to a post; `shelf_post(p_post_id uuid)` returns the same row shape for
one id, or nothing when the caller cannot see it. Both get the revoke/grant pair,
and both keep `set search_path = public` with the view named `private.`-qualified.

`shelf_post` must return the full column set, not a subset — that identity is what
the anti-drift test in §8 checks. Its three caller-context columns have no ranking
to come from, so `reposted_by_handle` and `reposted_by_name` are null and `reason`
is `'self'` when the caller wrote the post, `'following'` when they follow the
author, and `'popular'` otherwise. Low stakes either way: `reason` is typed in the
app and read nowhere in it.

This is the only step that touches a live hot path, so it carries a stop rule:
**`explain (analyze, buffers)` the new `shelf_feed` against the old one before
committing.** The risk is the planner evaluating the view's per-row scalar
subqueries before the `limit 50` in `scoped` rather than after. If it regresses,
fall back to leaving `shelf_feed` exactly as it is and building `shelf_post` on the
view alone — duplication in one direction only, with a comment saying so.

Doing visibility (Step 2) first is what makes this a *single* drop-and-create:
`visibility` is already on `posts` when the view is written, so the column reaches
both functions in the same statement.

### Step 4 — mention notifications

Smaller than `task.md` §6 suggests, because the app already parses, resolves and
links `@handle` itself (`RichText.tsx`, `TOKEN = /(@[a-z0-9_]{3,20}|#[A-Za-z0-9_]+)/gi`)
and the composer already autocompletes against `shelf_search_users`. Nothing renders
a mention from the server, so **no `post_mentions` table is needed** for the app to
work — only the bell.

A trigger on `posts` (insert, and update of `body`), `security definer`, in
`private`: extract distinct `@handle` tokens with the app's exact regex, lower-case
them, join `profiles`, drop self and blocked, **cap at 10 per post**, insert
`post_mention` rows `on conflict do nothing`. The cap is the point: a 500-character
body holds ~50 handles, and without it one post is a spam cannon. The dedupe index
already stops an edit from re-notifying the same person for the same post. Plus the
kind in `notifications_kind_check`, a `pushCopyFor` case, and another `push-sweep`
redeploy — so if this ships, ship it with Step 1 and redeploy once.

## 7. Decisions — both settled 18 Sep, do not reopen

| Question | Answer |
|---|---|
| What `friends` means | **Mutual follow.** Visible to accounts the author follows *and* who follow the author |
| Mention notifications | **In this pass**, capped at 10 per post, with the block check |

The reasoning behind each, since neither is recoverable from the code.

**What does `friends` mean on a graph that is deliberately asymmetric?**
(`20260908213000`: "follow, not friendship", chosen 8 Sep because the app's own UI
renders follower/following counts.)

- **Mutual follow** — visible to accounts the author follows *and* who follow the
  author. The only reading where the audience is one the author affirmatively chose;
  a stranger cannot add themselves to it by following. The obvious objection — "a
  friends-only post would be visible to nobody until people follow each other back" —
  **was measured and does not hold**: the live graph's 389 edges contain **145 mutual
  pairs, and 32 of the 33 accounts have at least one**. A friends-only post has a
  real audience the moment it is written, and the feature demos on the existing data.
- **Followers** — visible to anyone who follows the author. Marginally simpler; but
  anyone can join a "private" audience unilaterally, which is close enough to public
  that the pill would be misleading.
- **Don't build it this pass** — the app has no audience control at HEAD, so the
  column would ship unused. This repo has been bitten five times by config that
  exists and does nothing ([[shelf-repo-comments-assert-untrue-things]]). Against
  that: retrofitting RLS after launch is far harder than shipping it inert, and the
  default makes it a no-op until the client opts in.

**Decided: mutual follow, built now.** A third reading — "people the author
follows" — was considered and rejected: it collapses to mutual in the feed anyway
(the feed is following-driven) and differs only on the profile screen, where it
would confuse rather than protect.

**Mention notifications: in or out of this pass?** In favour: ~40 lines, the app
side is already done, and a mention that notifies nobody is the same dead-end the
repost button was. Against: it is the one item here that lets an account put itself
in a stranger's notification tray, and 12 days before ship is a poor moment to open
a new abuse surface. **Decided: in**, with the cap of 10 and the block check, both of
which are cheap and testable — so Step 4 is part of this pass, not an option, and
ships alongside Step 1 so `push-sweep` deploys once.

**Decided without asking, because it is one line to reverse:** a repost pushes, like
every other notification kind, rather than ringing the bell only.

## 8. Verification

A new `scripts/verify-feed.ts` (`npm run verify:feed`), in the house style —
`signUpWithProfile` throwaway accounts, `makeChecker()`, everything driven through
real JWTs because the service-role client cannot answer "what can a user reach".
Roughly 40 checks:

- **Reposts/notifications**: repost → author gets exactly one `post_repost` row;
  un-repost → re-repost → still one; self-repost → zero notifications (the repost
  row itself is allowed, and that is the assertion); a blocked account's repost is
  refused at insert with `42501` and leaves no notification; `repost_count` and
  `reposted_by_me` move; a followed account's repost surfaces the original with
  `reason = 'repost'` and `reposted_by_handle` set.
- **Visibility**, mirroring `verify-social.ts:168-176` exactly: a friends-only post
  is absent from a stranger's `shelf_feed` *and* from their direct
  `from('posts').select()`; absent for a one-way follower; present for a mutual and
  for the author; its comments and likes are unreadable by post id; a repost of it by
  a mutual does not leak it to the reposter's other followers;
  `shelf_profile_stats.post_count` excludes it; `shelf_create_post` defaults to
  `public` when `p_visibility` is omitted.
- **`shelf_post`**: same column set as `shelf_feed` (compare `Object.keys` — this is
  the anti-drift check); identical values for the same post; empty for a post the
  caller may not see; the poll block matches `shelf_poll`.
- **Regression**: `npm run verify:social` and `npm run verify:notifications` must
  both still pass untouched.

Then, per [[run-supabase-advisors-after-every-migration]], **run the advisors** —
this pass adds a definer trigger, a view and three rewritten policies, which is
exactly the shape that produced the `shelf_blocked_between` leak. Confirm
`post_cards` is *not* reported as a security-definer view.

**Before pushing, if the Supabase MCP is connected**, the visibility policy is worth
proving with a rollback `DO` block ([[verify-migrations-with-rollback-do-block]]):
create two accounts and a `friends` post inside the block, assert the non-mutual
account's `shelf_feed` and direct select both come back empty, then `raise` to roll
the whole thing back and confirm the row count afterwards. That is the cheapest way
to find out that a policy predicate is wrong — before it is a migration in history
rather than after.

Migrations cannot be applied from this sandbox ([[shelf-migrations-cannot-be-applied-from-this-sandbox]]).
Hand over, in order: `! npm run db:push` → `! npx supabase functions deploy push-sweep`
→ `! npm run verify:feed`.

## 9. Documentation owed

- **`docs/friends-feed-for-sola.md`** — new, and the dedicated-doc pattern, not a
  section of `technical-notes-for-sola.md` ([[shelf-quick-view-card]]). It is the
  only place the client contract should live: the 29→30 column feed row, the poll
  block, `shelf_post`, the repost write path, `p_visibility`, and the five client
  follow-ups below.
- **`technical-notes-for-sola.md` §4** — currently says the Friends tab "is still
  `FRIEND_POSTS`" and that notifications are "in-app only, no push". Both untrue.
  Correct it to a pointer.
- **`docs/STATUS.md`** — the feed is not in "PICK UP HERE" at all; it should be,
  with the `task.md`-is-stale finding, since the next person will otherwise read
  that note and build §3.
- **Not `docs/openapi.yaml`** — the API reference was retired 18 Sep
  ([[shelf-api-reference-deliverable]]); docs ship in the repo now.

**Client follow-ups for Sola** (none of them block the backend):

1. `notifications.ts`: add `'game_release' | 'post_repost'` to `NotificationKind`,
   add `game_id` / `game_title` / `game_cover_url` to `ShelfNotification`, and add
   the `describe()` / `iconFor()` cases. **`game_release` renders blank today** —
   this is a live bug, independent of everything above.
2. `NotificationsScreen.tsx`: replace `findPostById`'s four-page scan with
   `rpc('shelf_post', { p_post_id })` — deletes ~20 lines and up to 200 joined rows
   per tap, and makes repost/mention notifications openable.
3. `feed.ts`: `createPost` gains `visibility?: 'public' | 'friends'` → `p_visibility`;
   `FeedPost` gains `visibility`.
4. `ComposePostScreen.tsx`: the audience selector the old "Public ⌄" pill was going
   to be. It does not exist at HEAD.
5. `PostCard.tsx`: optional "Friends only" badge when `visibility === 'friends'`, so
   an author can see which of their own posts is restricted.

### Send Sola this much now, before any of it is built

Items 1 and 2 are worth having independently of this plan, and the note he sent is
worth correcting before he waits on work that already exists:

> Two things on the feed, neither blocking you:
>
> **Your `NotificationKind` is missing two kinds.** The server can already emit
> `game_release` (0 rows so far, so you haven't seen it) and will emit `post_repost`
> shortly. Both fall through `describe()` to `''` and `iconFor()` to `undefined`, so
> they render as a name with no text and no icon. `shelf_notifications` also already
> returns `game_id`, `game_title` and `game_cover_url`, which `ShelfNotification`
> doesn't type — a `game_release` row should open the game, a `post_repost` row the
> post.
>
> **`shelf_post(p_post_id)` is coming**, so you can drop `findPostById`'s four-page
> scan — opening one post from a notification currently fetches up to 200 fully
> joined feed rows and only works for your own posts.
>
> Also: most of the backend in your note is already live and the app is already using
> it — category, polls, votes, reposts, shares and the "X reposted" card all work
> server-side today. What's actually missing is repost notifications, post
> visibility, and the single-post fetch above.

## 10. Loose ends found on the way, not in scope

- **`psn-import` is called by the app and is not deployed** — `POST /functions/v1/psn-import`
  returns **404** live (`game-artwork` returns 401 for the same unauthenticated call,
  so this is a missing function, not an auth artefact). It sits behind
  `EXPO_PUBLIC_PSN_IMPORT`, which is off, so nothing is broken today. PlayStation
  linking is already on the roadmap; this is what "not started" looks like from the
  app's side.
- **Nobody has still said who applied the live poll/repost/share schema**, or when.
  `20260918120000` declared it; the question it raised is still open.
- **`post_shares` has no delete policy and no un-share path** — deliberate, live
  ("a share is a fact, not a toggle"), and the app matches it. Noted so it is not
  read as a gap.
