# link-lab — measurements behind `docs/research/account-linking.md`

Every number in that document came out of these four scripts, run against the live
IGDB API and the live Supabase project on 12 September 2026. They are read-only:
nothing here writes to the database.

```sh
set -a; . ./.env; set +a
npx tsx scripts/link-lab/external-id-coverage.ts   # section 1, table 3
npx tsx scripts/link-lab/steam-resolution.ts       # section 1, table 1 (+ parent hop)
npx tsx scripts/link-lab/gap-diagnosis.ts          # section 1, table 2
npx tsx scripts/link-lab/name-match.ts             # section 2a
```

They read `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`. Each takes one to three minutes — IGDB is throttled to
4 requests/second and these page through thousands of ids.

**The one unauthenticated dependency is SteamSpy**, used only as a proxy for "what
is actually in people's Steam libraries" (its `all` pages are sorted by owner
count). If it disappears, substitute any list of appids ordered by ownership. Note
what that proxy costs you: a real library skews cheaper and more obscure than the
top 2,000 apps, so **87.8% is an optimistic bound** until it is re-run against a
real Steam account. That is the first thing to do once anyone links one.

`name-match.ts` is the one to re-run after the `standard edition` migration lands —
it is what found that bug, and the Xbox rank-1 figure (96.3%) should rise.
