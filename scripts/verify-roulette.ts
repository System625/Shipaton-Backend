// Exercises the DEPLOYED /roulette against a real signed JWT.
//
// Roulette is the first endpoint that reads USER data rather than the catalog, and
// `library_entries` is empty on the live project with nothing yet writing to it
// (share-confirm is step 7 and undeployed). So this script builds its own backlog
// fixture as the service role, rolls against it through the deployed function under
// the user's own token, and tears the whole thing down again. Safe to re-run.
//
// The property that matters most, and the reason the input is split in two
// (spec section 7): a backlog of nothing but big RPGs must NEVER come back empty
// just because the session is short. `hours` reweights; `size` is the only filter.
// `null` means "backlog empty on that platform" and must never mean "your filters
// excluded everything".

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import {
  COVER_COLOR_KEYS,
  type CatalogGame,
} from "../supabase/functions/_shared/catalog-game.ts";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;

const RUN = Date.now();
const PASSWORD = `Shelf-roulette-${RUN}!`;

// Platform ids as the app sees them in PlatformRef.id.
const PC = 6;
const PS5 = 167;
// Nothing in the fixture is released on the Dreamcast, which is the point: it is the
// platform that proves an empty backlog answers `null` rather than erroring.
const DREAMCAST = 23;

// Resolved by slug at runtime so a catalog reseed cannot silently change which game
// a check is really about. `size` is what the SQL buckets on: quick <10h, medium
// 10-30h, epic >30h, against ttb_normally_hours.
const FIXTURE = [
  { slug: "journey",                 size: "quick",  status: "backlog", on: [PC] },
  { slug: "inside",                  size: "quick",  status: "backlog", on: [PC] },
  { slug: "portal-2",                size: "medium", status: "playing", on: [PC] },
  { slug: "celeste",                 size: "medium", status: "backlog", on: [PC] },
  { slug: "disco-elysium",           size: "epic",   status: "backlog", on: [PC] },
  { slug: "hollow-knight",           size: "epic",   status: "backlog", on: [PC, PS5] },
  { slug: "the-witcher-3-wild-hunt", size: "epic",   status: "backlog", on: [PC, PS5] },
  { slug: "cyberpunk-2077",          size: "epic",   status: "playing", on: [PC, PS5] },
  { slug: "elden-ring",              size: "epic",   status: "backlog", on: [PC, PS5] },
] as const;

// Rows roulette must never return, whatever the parameters. A finished game is not
// a suggestion.
const EXCLUDED = [
  // IGDB's slug for Hades really is `hades--1`; `hades` is a different game.
  { slug: "hades--1", status: "beaten" },
  { slug: "stardew-valley", status: "dropped" },
] as const;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function call(path: string, token?: string) {
  const res = await fetch(`${FUNCTIONS}${path}`, {
    headers: {
      apikey: ANON_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/**
 * Roll n times and return what came back. Rolls are independent, so they go out
 * eight at a time — a distribution check needs enough samples that doing them one
 * after another dominates the runtime of the whole script.
 */
async function rollMany(query: string, token: string, n: number) {
  const titles: string[] = [];
  let nulls = 0;
  let error: string | undefined;
  for (let i = 0; i < n; i += 8) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(8, n - i) }, () => call(`/roulette?${query}`, token)),
    );
    for (const res of batch) {
      if (res.status !== 200) { error ??= `HTTP ${res.status}`; continue; }
      const g = res.body as CatalogGame | null;
      if (g === null) nulls++;
      else titles.push(g.title);
    }
    if (error) break;
  }
  return { titles, nulls, error };
}

/** Share of rolls that came back as `title`. */
function shareOf(titles: string[], title: string) {
  return titles.length === 0 ? 0 : titles.filter((t) => t === title).length / titles.length;
}

function checkShape(label: string, g: CatalogGame) {
  check(`${label}: id is a uuid`, typeof g.id === "string" && /^[0-9a-f-]{36}$/i.test(g.id));
  check(`${label}: title is a non-empty string`, typeof g.title === "string" && g.title.length > 0);
  check(`${label}: platforms is an array`, Array.isArray(g.platforms), `${g.platforms?.length} entries`);
  check(`${label}: genres is an array`, Array.isArray(g.genres));
  check(`${label}: abbreviation is 2-3 chars`,
    typeof g.abbreviation === "string" && g.abbreviation.length >= 2 && g.abbreviation.length <= 3,
    g.abbreviation);
  check(`${label}: colorKey is one the app can render`,
    (COVER_COLOR_KEYS as readonly string[]).includes(g.colorKey), g.colorKey);
  // score is a ranking internal; toCatalogGame drops it and the app must not see it.
  check(`${label}: score is not exposed`, !("score" in g));
}

async function main() {
  console.log(`\nDeployed /roulette verification against ${FUNCTIONS}\n`);

  const slugs = [...FIXTURE.map((f) => f.slug), ...EXCLUDED.map((e) => e.slug)];
  const { data: games, error: gamesError } = await admin
    .from("games").select("id, slug, title, ttb_normally_hours, session_fit").in("slug", slugs);
  if (gamesError) throw new Error(`catalog lookup: ${gamesError.message}`);
  const bySlug = new Map(games!.map((g) => [g.slug as string, g]));
  const missing = slugs.filter((s) => !bySlug.has(s));
  if (missing.length) throw new Error(`fixture games not in catalog: ${missing.join(", ")}`);

  const email = `verify+roulette-${RUN}@shelf.test`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (createError) throw new Error(`createUser: ${createError.message}`);
  const userId = created.user!.id;

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } =
    await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  const token = signedIn.session!.access_token;

  try {
    // ---- 1. Auth and parameter handling, before any backlog exists ----
    console.log("1. Auth and parameters");
    const noAuth = await call(`/roulette?platform=${PC}`);
    check("no Authorization header is rejected", noAuth.status === 401, `HTTP ${noAuth.status}`);
    const badAuth = await call(`/roulette?platform=${PC}`, "not-a-real-token");
    check("a garbage bearer token is rejected", badAuth.status === 401, `HTTP ${badAuth.status}`);

    // The bug this release fixes: Number(null) is 0 and Number.isInteger(0) is true,
    // so a MISSING platform used to sail through as platform 0 and return `null` —
    // indistinguishable from an empty backlog.
    const noPlatform = await call("/roulette", token);
    check("a missing platform is a 400, not a silent null",
      noPlatform.status === 400, `HTTP ${noPlatform.status}`);
    check("...with the documented message",
      (noPlatform.body as { error?: string })?.error === "platform is required",
      JSON.stringify(noPlatform.body));

    const emptyPlatform = await call("/roulette?platform=", token);
    check("an empty platform value is a 400 too", emptyPlatform.status === 400,
      `HTTP ${emptyPlatform.status}`);
    const badPlatform = await call("/roulette?platform=abc", token);
    check("a non-numeric platform is a 400", badPlatform.status === 400,
      `HTTP ${badPlatform.status}`);
    const fractional = await call("/roulette?platform=6.5", token);
    check("a fractional platform is a 400", fractional.status === 400,
      `HTTP ${fractional.status}`);
    const badSize = await call(`/roulette?platform=${PC}&size=huge`, token);
    check("an unknown size is a 400", badSize.status === 400, `HTTP ${badSize.status}`);
    check("...with the documented message",
      (badSize.body as { error?: string })?.error === "size must be quick, medium or epic");

    const post = await fetch(`${FUNCTIONS}/roulette?platform=${PC}`, {
      method: "POST", headers: { apikey: ANON_KEY, Authorization: `Bearer ${token}` },
    });
    check("POST is a 405", post.status === 405, `HTTP ${post.status}`);

    // ---- 2. An empty backlog is `null`, and that is a real answer ----
    console.log("\n2. Empty backlog");
    const beforeSeed = await call(`/roulette?platform=${PC}`, token);
    check("a user with no library rows gets 200 null",
      beforeSeed.status === 200 && beforeSeed.body === null,
      `HTTP ${beforeSeed.status} ${JSON.stringify(beforeSeed.body)}`);

    // ---- 3. Seed the backlog ----
    console.log("\n3. Seeding a backlog fixture");
    const rows = [
      ...FIXTURE.map((f) => ({
        user_id: userId, game_id: bySlug.get(f.slug)!.id, status: f.status,
        source_kind: "manual" as const,
      })),
      ...EXCLUDED.map((e) => ({
        user_id: userId, game_id: bySlug.get(e.slug)!.id, status: e.status,
        source_kind: "manual" as const,
      })),
    ];
    const { error: seedError } = await admin.from("library_entries").insert(rows);
    if (seedError) throw new Error(`seeding library_entries: ${seedError.message}`);
    check("fixture inserted", true, `${rows.length} library entries`);

    // ---- 4. It actually rolls ----
    console.log("\n4. Rolling");
    const roll = await call(`/roulette?platform=${PC}`, token);
    check("a seeded backlog returns 200", roll.status === 200, `HTTP ${roll.status}`);
    const picked = roll.body as CatalogGame | null;
    check("...and returns a game, not null", picked !== null, picked?.title);
    if (picked) checkShape("roulette", picked);

    const pcTitles = new Set(FIXTURE.map((f) => bySlug.get(f.slug)!.title as string));
    if (picked) {
      check("the pick is from the caller's own backlog", pcTitles.has(picked.title), picked.title);
      check("the pick is playable on the platform asked for",
        picked.platforms.some((p) => p.id === PC),
        picked.platforms.map((p) => p.name).join(", "));
    }

    const spread = await rollMany(`platform=${PC}&hours=6`, token, 25);
    check("repeated rolls do not always return the same game",
      new Set(spread.titles).size > 1, `${new Set(spread.titles).size} distinct in 25 rolls`);

    // ---- 5. Finished and abandoned games are never suggested ----
    console.log("\n5. Exclusions");
    const wide = await rollMany(`platform=${PC}&hours=6`, token, 40);
    const excludedTitles = EXCLUDED.map((e) => bySlug.get(e.slug)!.title as string);
    const leaked = wide.titles.filter((t) => excludedTitles.includes(t));
    check("a 'beaten' or 'dropped' entry is never returned", leaked.length === 0,
      leaked.length ? `leaked ${[...new Set(leaked)].join(", ")}` : "40 rolls clean");
    check("no roll on a stocked platform came back null", wide.nulls === 0,
      `${wide.nulls} nulls in 40 rolls`);

    const dreamcast = await call(`/roulette?platform=${DREAMCAST}`, token);
    check("a platform the backlog has nothing on returns null",
      dreamcast.status === 200 && dreamcast.body === null,
      `HTTP ${dreamcast.status} ${JSON.stringify(dreamcast.body)}`);

    // ---- 6. size is the only filter, and it filters correctly ----
    console.log("\n6. size buckets");
    const bucketOf = new Map(FIXTURE.map((f) => [bySlug.get(f.slug)!.title as string, f.size]));
    for (const bucket of ["quick", "medium", "epic"] as const) {
      const res = await rollMany(`platform=${PC}&size=${bucket}&hours=3`, token, 20);
      const wrong = [...new Set(res.titles)].filter((t) => bucketOf.get(t) !== bucket);
      check(`size=${bucket} returns only ${bucket} games`, wrong.length === 0,
        wrong.length ? `got ${wrong.join(", ")}` : [...new Set(res.titles)].join(", "));
      check(`size=${bucket} finds something`, res.nulls === 0 && res.titles.length > 0,
        `${res.nulls} nulls`);
    }

    // ---- 7. THE ONE THAT MATTERS: hours never empties a backlog ----
    console.log("\n7. hours reweights, never filters (spec section 7)");
    // Every PS5 entry in the fixture is over 30 hours to beat — the "backlog of big
    // RPGs" the split exists for. A 30-minute session must still get an answer.
    const shortEvening = await rollMany(`platform=${PS5}&hours=0.5`, token, 30);
    check("a 30-minute session against an all-epic backlog is never empty",
      shortEvening.nulls === 0 && shortEvening.titles.length === 30,
      `${shortEvening.nulls} nulls in 30 rolls`);
    const ps5Epics = FIXTURE.filter((f) => (f.on as readonly number[]).includes(PS5))
      .map((f) => bySlug.get(f.slug)!.title as string);
    check("...and every game it offered is one of the big ones",
      [...new Set(shortEvening.titles)].every((t) => ps5Epics.includes(t)),
      [...new Set(shortEvening.titles)].join(", "));

    // The same at the far end of the range, and with an absurd value.
    for (const hours of ["0.25", "1", "12", "0", "-3", "abc"]) {
      const res = await rollMany(`platform=${PS5}&hours=${hours}`, token, 6);
      check(`hours=${hours} still returns a game`, res.nulls === 0 && !res.error,
        res.error ?? `${res.nulls} nulls in 6 rolls`);
    }

    // A short evening must not quietly become a size filter: the long low-fit games
    // have to stay reachable, not just non-null.
    const shortOnPc = await rollMany(`platform=${PC}&hours=0.5`, token, 60);
    const epicsSeen = [...new Set(shortOnPc.titles)].filter((t) => bucketOf.get(t) === "epic");
    check("long games remain reachable in a short session",
      epicsSeen.length > 0, epicsSeen.join(", ") || "no epic game surfaced in 60 short-session rolls");

    // The check that would have caught the inert-hours bug. Under weighted random
    // selection a short evening tilts toward resuming and high session_fit, so
    // Portal 2 — the only fixture entry that is both 'playing' and high fit — must
    // come up markedly more often at 30 minutes than at 8 hours, where the weights
    // flatten to uniform. Expected roughly 28% against 11%; the assertion only
    // demands a 5-point gap, so ordinary sampling noise cannot fail it.
    const shortDist = await rollMany(`platform=${PC}&hours=0.5`, token, 150);
    const longDist = await rollMany(`platform=${PC}&hours=8`, token, 150);
    const shortShare = shareOf(shortDist.titles, "Portal 2");
    const longShare = shareOf(longDist.titles, "Portal 2");
    check("hours actually changes the odds, rather than being decorative",
      shortShare > longShare + 0.05,
      `Portal 2: ${(shortShare * 100).toFixed(0)}% at 0.5h vs ${(longShare * 100).toFixed(0)}% at 8h`);
    check("a long evening spreads across most of the backlog",
      new Set(longDist.titles).size >= 7, `${new Set(longDist.titles).size} of 9 seen in 150 rolls`);

    // ---- 8. RLS: one user's backlog is not another's ----
    console.log("\n8. Isolation");
    const otherEmail = `verify+roulette-other-${RUN}@shelf.test`;
    const { data: other, error: otherError } = await admin.auth.admin.createUser({
      email: otherEmail, password: PASSWORD, email_confirm: true,
    });
    if (otherError) throw new Error(`createUser (other): ${otherError.message}`);
    try {
      const { data: otherSignIn } =
        await anon.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
      const otherToken = otherSignIn!.session!.access_token;
      const theirs = await rollMany(`platform=${PC}&hours=6`, otherToken, 5);
      check("a second user sees none of the first user's backlog",
        theirs.nulls === 5 && theirs.titles.length === 0,
        theirs.titles.length ? `leaked ${[...new Set(theirs.titles)].join(", ")}` : "5 nulls");
    } finally {
      await admin.auth.admin.deleteUser(other.user!.id);
    }
  } finally {
    // library_entries cascades on auth.users delete, so this removes the fixture too.
    await admin.auth.admin.deleteUser(userId);
    console.log("\ncleaned up test user and its library entries.");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
