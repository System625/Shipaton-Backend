// Exercises the DEPLOYED /search and /games/:id against a real signed JWT.
//
// Everything before this was verified locally or through the database directly.
// This is the first check that walks the whole deployed path the app will walk:
// GoTrue issues a token, the edge runtime verifies it, `_shared/http.ts` rebuilds a
// client from it, RLS applies, and the response comes back shaped by toCatalogGame.
//
// It also pins the response *shape*, which is the thing the app compiles against.
// COVER_COLOR_KEYS is imported from the real module rather than restated, so if the
// palette drifts from the app's theme.ts again this fails instead of silently
// rendering grey.
//
// Creates its own user and removes it again. Safe to re-run.

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
const PASSWORD = `Shelf-verify-${RUN}!`;

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

/** Every field the app compiles against, checked on one real row. */
function checkShape(label: string, g: CatalogGame) {
  check(`${label}: id is a uuid`, typeof g.id === "string" && /^[0-9a-f-]{36}$/i.test(g.id));
  check(`${label}: title is a non-empty string`, typeof g.title === "string" && g.title.length > 0);
  check(`${label}: slug present`, typeof g.slug === "string" && g.slug.length > 0, String(g.slug));
  check(`${label}: platforms is an array`, Array.isArray(g.platforms), `${g.platforms?.length} entries`);
  check(`${label}: genres is an array`, Array.isArray(g.genres), `${g.genres?.length} entries`);
  check(`${label}: abbreviation is 2-3 chars`,
    typeof g.abbreviation === "string" && g.abbreviation.length >= 2 && g.abbreviation.length <= 3,
    g.abbreviation);
  check(`${label}: colorKey is one the app can render`,
    (COVER_COLOR_KEYS as readonly string[]).includes(g.colorKey), g.colorKey);
  if (g.platforms?.length) {
    const p = g.platforms[0];
    check(`${label}: platform ref has id/name/slug`,
      typeof p.id === "number" && typeof p.name === "string" && typeof p.slug === "string",
      p.name);
  }
}

async function main() {
  console.log(`\nDeployed edge function verification against ${FUNCTIONS}\n`);

  const email = `verify+fn-${RUN}@shelf.test`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (createError) throw new Error(`createUser: ${createError.message}`);

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } =
    await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  const token = signedIn.session!.access_token;

  try {
    // ---- 1. Auth is actually enforced on the deployed function ----
    console.log("1. Auth enforcement");
    const noAuth = await call("/search?q=elden%20ring");
    check("no Authorization header is rejected", noAuth.status === 401, `HTTP ${noAuth.status}`);
    const badAuth = await call("/search?q=elden%20ring", "not-a-real-token");
    check("a garbage bearer token is rejected", badAuth.status === 401, `HTTP ${badAuth.status}`);

    // ---- 2. /search on real data ----
    console.log("\n2. /search");
    const search = await call("/search?q=elden%20ring", token);
    check("authenticated search returns 200", search.status === 200, `HTTP ${search.status}`);
    const results = search.body as CatalogGame[];
    check("returns an array", Array.isArray(results), `${results?.length} results`);

    const rank = results?.findIndex((g) => g.title === "Elden Ring") ?? -1;
    check("Elden Ring is in the top 5", rank >= 0 && rank < 5,
      rank < 0 ? "not found at all" : `rank ${rank + 1} of ${results.length}`);
    if (rank >= 0) checkShape("elden ring", results[rank]);

    const short = await call("/search?q=a", token);
    check("a one-character query returns []",
      short.status === 200 && Array.isArray(short.body) && (short.body as []).length === 0);

    // A back-catalogue title proves the second seed pass is live, not just seeded.
    const witcher = await call("/search?q=witcher%203", token);
    const witcherHit = (witcher.body as CatalogGame[])?.some((g) => /witcher 3/i.test(g.title));
    check("pre-2023 back catalogue is reachable", witcherHit === true);

    // ---- 3. /games/:id ----
    console.log("\n3. /games/:id");
    const target = results?.[rank >= 0 ? rank : 0];
    const detail = await call(`/games/${target.id}`, token);
    check("fetching a real id returns 200", detail.status === 200, `HTTP ${detail.status}`);
    const game = detail.body as CatalogGame;
    check("returns the same game", game?.id === target.id, game?.title);
    checkShape("detail", game);
    check("detail and search agree on colorKey", game?.colorKey === target.colorKey);

    const badId = await call("/games/not-a-uuid", token);
    check("a non-uuid is rejected with 400", badId.status === 400, `HTTP ${badId.status}`);
    const missing = await call("/games/00000000-0000-4000-8000-000000000000", token);
    check("an unknown uuid is 404", missing.status === 404, `HTTP ${missing.status}`);
    const detailNoAuth = await call(`/games/${target.id}`);
    check("/games requires auth too", detailNoAuth.status === 401, `HTTP ${detailNoAuth.status}`);
  } finally {
    await admin.auth.admin.deleteUser(created.user!.id);
    console.log("\ncleaned up test user.");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
