// Re-runs the cross-user RLS check through the REAL token path.
//
// The check recorded in docs/STATUS.md step 3 simulated a session with
// `set_config('request.jwt.claims', ...)`, which exercises the policies but not the
// token path: no signature, no GoTrue, no PostgREST claim parsing. This script signs
// two real users in, takes the access tokens GoTrue actually issues, and builds the
// clients exactly the way `_shared/http.ts` builds them — anon key plus the caller's
// Authorization header — so a pass here covers the same path an edge function walks.
//
// Provider-agnostic on purpose. Google or Apple change who mints the identity, not
// the shape of the JWT or how RLS reads it, so this stays valid once they are on.
//
// Creates its own users and catalog rows and removes them again. Safe to re-run.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");

const RUN = Date.now();
const PASSWORD = `Shelf-verify-${RUN}!`;
const TEST_PLATFORM_ID = 999_001; // outside IGDB's id range; removed at the end

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Same construction as _shared/http.ts: anon key + the caller's bearer token. */
function clientFor(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

function decodeJwt(token: string) {
  const [header, payload] = token.split(".").slice(0, 2)
    .map((p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
  return { header, payload };
}

async function createSignedInUser(tag: string) {
  const email = `verify+${tag}-${RUN}@shelf.test`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (createError) throw new Error(`createUser(${tag}): ${createError.message}`);

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } =
    await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn(${tag}): ${signInError.message}`);

  const accessToken = signedIn.session!.access_token;
  return { tag, id: created.user!.id, email, accessToken, client: clientFor(accessToken) };
}

async function main() {
  console.log(`\nReal-JWT auth + RLS verification against ${SUPABASE_URL}\n`);

  const a = await createSignedInUser("a");
  const b = await createSignedInUser("b");
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let gameId: string | undefined;

  try {
    // ---- 1. The token is genuinely signed, and carries the claims RLS reads ----
    console.log("1. Token shape");
    const { header, payload } = decodeJwt(a.accessToken);
    check("signed with a real algorithm", typeof header.alg === "string" && header.alg !== "none",
      `alg=${header.alg}${header.kid ? `, kid=${String(header.kid).slice(0, 8)}…` : ""}`);
    check("sub is user A's uuid", payload.sub === a.id);
    check("role claim is authenticated", payload.role === "authenticated", `role=${payload.role}`);
    check("carries a session_id (a real GoTrue session)", typeof payload.session_id === "string");
    check("carries aal and an expiry", !!payload.aal && typeof payload.exp === "number",
      `aal=${payload.aal}`);

    // ---- 2. The exact call _shared/http.ts makes to authenticate a request ----
    console.log("\n2. Edge-function auth path (supabase.auth.getUser)");
    const { data: gotUser, error: getUserError } = await a.client.auth.getUser();
    check("getUser() resolves the caller", !getUserError && gotUser?.user?.id === a.id,
      getUserError?.message);
    const { data: noUser, error: badTokenError } =
      await clientFor(`${a.accessToken.slice(0, -4)}xxxx`).auth.getUser();
    check("a tampered signature is rejected", !!badTokenError || !noUser?.user,
      badTokenError?.message);

    // ---- 3. Catalog fixtures (service role, RLS bypassed) ----
    const { error: platformError } = await admin.from("platforms").upsert({
      id: TEST_PLATFORM_ID, slug: `verify-platform-${RUN}`, name: "Verify Platform", family: "pc",
    });
    if (platformError) throw new Error(`platform fixture: ${platformError.message}`);

    const { data: game, error: gameError } = await admin.from("games")
      .insert({ title: `Verify Fixture ${RUN}`, match_title: "placeholder", session_fit: "high",
                ttb_normally_hours: 12 })
      .select("id").single();
    if (gameError) throw new Error(`game fixture: ${gameError.message}`);
    gameId = game.id;
    await admin.from("game_platforms").insert({ game_id: gameId, platform_id: TEST_PLATFORM_ID });

    // ---- 4. Catalog visibility ----
    console.log("\n3. Catalog reads");
    const { data: aCatalog } = await a.client.from("games").select("id").eq("id", gameId!);
    check("authenticated user reads the catalog", (aCatalog?.length ?? 0) === 1);
    const { data: anonCatalog } = await anon.from("games").select("id").eq("id", gameId!);
    check("anon reads nothing", (anonCatalog?.length ?? 0) === 0);

    // ---- 5. Owner writes ----
    console.log("\n4. User A owns its row");
    const { data: entry, error: insertError } = await a.client.from("library_entries")
      .insert({ user_id: a.id, game_id: gameId, status: "backlog",
                platform_id: TEST_PLATFORM_ID, source_kind: "manual" })
      .select("id").single();
    check("A inserts its own entry", !insertError && !!entry, insertError?.message);
    const { data: aRead } = await a.client.from("library_entries").select("id").eq("user_id", a.id);
    check("A reads its own entry back", (aRead?.length ?? 0) === 1);

    // ---- 6. The isolation that matters ----
    console.log("\n5. User B is walled off from A");
    const { data: bRead } = await b.client.from("library_entries").select("id").eq("user_id", a.id);
    check("B cannot read A's entries", (bRead?.length ?? 0) === 0);

    const { data: bUpdate } = await b.client.from("library_entries")
      .update({ status: "beaten" }).eq("user_id", a.id).select("id");
    check("B cannot update A's entries", (bUpdate?.length ?? 0) === 0);

    const { data: bDelete } = await b.client.from("library_entries")
      .delete().eq("user_id", a.id).select("id");
    check("B cannot delete A's entries", (bDelete?.length ?? 0) === 0);

    const { error: bForgeError } = await b.client.from("library_entries")
      .insert({ user_id: a.id, game_id: gameId, status: "backlog", source_kind: "manual" });
    check("B cannot insert a row owned by A", !!bForgeError, bForgeError?.code);

    // ---- 7. shelf_roulette's own auth.uid() guard ----
    console.log("\n6. shelf_roulette under real JWTs");
    const { data: aRoulette, error: aRouletteError } = await a.client.rpc("shelf_roulette", {
      p_user_id: a.id, p_platform_id: TEST_PLATFORM_ID, p_session_hours: 2,
    });
    check("A rolls its own backlog", !aRouletteError && (aRoulette?.length ?? 0) === 1,
      aRouletteError?.message);

    const { data: bRoulette } = await b.client.rpc("shelf_roulette", {
      p_user_id: a.id, p_platform_id: TEST_PLATFORM_ID, p_session_hours: 2,
    });
    check("B rolling with A's uuid gets nothing", (bRoulette?.length ?? 0) === 0);

    const { error: anonRouletteError } = await anon.rpc("shelf_roulette", {
      p_user_id: a.id, p_platform_id: TEST_PLATFORM_ID, p_session_hours: 2,
    });
    check("anon has no EXECUTE on shelf_roulette", !!anonRouletteError, anonRouletteError?.code);

    const { error: anonSearchError } = await anon.rpc("shelf_search_games", {
      q: "anything", max_results: 1,
    });
    check("anon has no EXECUTE on shelf_search_games", !!anonSearchError, anonSearchError?.code);
  } finally {
    // ---- Cleanup. The catalog goes back to empty; see STATUS "deliberately empty". ----
    if (gameId) {
      await admin.from("library_entries").delete().eq("game_id", gameId);
      await admin.from("game_platforms").delete().eq("game_id", gameId);
      await admin.from("games").delete().eq("id", gameId);
    }
    await admin.from("platforms").delete().eq("id", TEST_PLATFORM_ID);
    await admin.auth.admin.deleteUser(a.id);
    await admin.auth.admin.deleteUser(b.id);
    console.log("\nCleaned up: 2 users, 1 game, 1 platform, 1 library entry.");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nverify-auth-rls aborted:", err.message);
  process.exit(1);
});
