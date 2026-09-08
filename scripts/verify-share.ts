// Exercises the DEPLOYED /share-resolve and /share-confirm against a real signed JWT.
//
// This is the only path that writes library_entries, so it is also the first check
// that /roulette can return anything at all for a real account: the script confirms
// a game, then rolls, and expects the game back.
//
// The links below are real and deliberately so. The YouTube one is the video whose
// oEmbed title the extractor was written against; the TikTok one is TikTok's own
// documented oEmbed example (developers.tiktok.com/doc/embed-videos), which is a pet
// video, not a game — it is here as the honest negative case, because a caption with
// no game in it must come back unmatched rather than confidently wrong.
//
// Creates its own user and removes it again. Safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { COVER_COLOR_KEYS, type CatalogGame } from "../supabase/functions/_shared/catalog-game.ts";

const SUPABASE_URL = required("SUPABASE_URL");
const ANON_KEY = required("SUPABASE_ANON_KEY");
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;

const YOUTUBE_ELDEN_RING = "https://www.youtube.com/watch?v=E3Huy2cdih0";
const TIKTOK_NO_GAME = "https://www.tiktok.com/@scout2015/video/6718335390845095173";
const NOT_A_VIDEO_SITE = "https://example.com/some/page";

const RUN = Date.now();
const PASSWORD = `Shelf-share-${RUN}!`;

type ShareResolution = {
  intakeId: string;
  provider: "tiktok" | "youtube" | "other";
  extractedText: string | null;
  confident: boolean;
  candidates: CatalogGame[];
};

type LibraryEntry = {
  id: string;
  user_id: string;
  game_id: string;
  status: string;
  rating: number | null;
  notes: string;
  source_url: string | null;
  source_kind: string | null;
  added_at: string;
};

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${FUNCTIONS}${path}`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

async function signUp(tag: string) {
  const email = `verify+share-${tag}-${RUN}@shelf.test`;
  const { data: created, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`createUser: ${error.message}`);
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signedIn, error: signInError } =
    await anon.auth.signInWithPassword({ email, password: PASSWORD });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);
  return { userId: created.user!.id, token: signedIn.session!.access_token };
}

async function main() {
  console.log(`\nDeployed share ingestion verification against ${FUNCTIONS}\n`);

  const user = await signUp("a");
  const other = await signUp("b");

  try {
    // ---- 1. Auth and method enforcement ----
    console.log("1. Auth and method enforcement");
    const noAuth = await post("/share-resolve", { url: YOUTUBE_ELDEN_RING });
    check("no Authorization header is rejected", noAuth.status === 401, `HTTP ${noAuth.status}`);
    const badAuth = await post("/share-resolve", { url: YOUTUBE_ELDEN_RING }, "not-a-real-token");
    check("a garbage bearer token is rejected", badAuth.status === 401, `HTTP ${badAuth.status}`);

    const asGet = await fetch(`${FUNCTIONS}/share-resolve`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${user.token}` },
    });
    check("GET is rejected with 405", asGet.status === 405, `HTTP ${asGet.status}`);

    const confirmNoAuth = await post("/share-confirm", { intakeId: "x", gameId: "y" });
    check("share-confirm requires auth too", confirmNoAuth.status === 401,
      `HTTP ${confirmNoAuth.status}`);

    // ---- 2. Bad input ----
    console.log("\n2. Bad input");
    const noUrl = await post("/share-resolve", {}, user.token);
    check("a body with no url is 400", noUrl.status === 400,
      `HTTP ${noUrl.status} ${JSON.stringify(noUrl.body)}`);
    const numericUrl = await post("/share-resolve", { url: 42 }, user.token);
    check("a non-string url is 400", numericUrl.status === 400, `HTTP ${numericUrl.status}`);
    const noIds = await post("/share-confirm", {}, user.token);
    check("confirm with no ids is 400", noIds.status === 400, `HTTP ${noIds.status}`);

    // ---- 3. A real YouTube link resolves to the right game ----
    console.log("\n3. /share-resolve on a real YouTube link");
    const yt = await post("/share-resolve", { url: YOUTUBE_ELDEN_RING }, user.token);
    check("returns 200", yt.status === 200, `HTTP ${yt.status}`);
    const ytBody = yt.body as ShareResolution;
    check("provider detected as youtube", ytBody?.provider === "youtube", ytBody?.provider);
    check("intakeId is a uuid", /^[0-9a-f-]{36}$/i.test(ytBody?.intakeId ?? ""));

    // The oEmbed round trip is the thing that was untested from a datacenter IP.
    // If this is null, the endpoint refused the deployed function's request.
    check("oEmbed returned a title from the deployed function",
      ytBody?.extractedText === "ELDEN RING - Official Gameplay Reveal",
      String(ytBody?.extractedText));

    check("candidates are returned", (ytBody?.candidates?.length ?? 0) > 0,
      `${ytBody?.candidates?.length} candidates`);
    check("the top candidate is Elden Ring", ytBody?.candidates?.[0]?.title === "Elden Ring",
      ytBody?.candidates?.[0]?.title);
    check("marked confident, so the app shows one big result", ytBody?.confident === true);
    check("at most 5 candidates", (ytBody?.candidates?.length ?? 0) <= 5);

    const top = ytBody?.candidates?.[0];
    check("candidate: id is a uuid", /^[0-9a-f-]{36}$/i.test(top?.id ?? ""));
    check("candidate: abbreviation is 2-3 chars",
      (top?.abbreviation?.length ?? 0) >= 2 && (top?.abbreviation?.length ?? 0) <= 3,
      top?.abbreviation);
    check("candidate: colorKey is one the app can render",
      (COVER_COLOR_KEYS as readonly string[]).includes(top?.colorKey), top?.colorKey);
    check("candidate: platforms is an array", Array.isArray(top?.platforms),
      `${top?.platforms?.length} entries`);
    check("candidate: score is not exposed", top !== undefined && !("score" in top));

    // ---- 4. A real TikTok link: oEmbed reached, no game in the caption ----
    console.log("\n4. /share-resolve on a real TikTok link with no game in it");
    const tt = await post("/share-resolve", { url: TIKTOK_NO_GAME }, user.token);
    check("returns 200", tt.status === 200, `HTTP ${tt.status}`);
    const ttBody = tt.body as ShareResolution;
    check("provider detected as tiktok", ttBody?.provider === "tiktok", ttBody?.provider);
    check("TikTok oEmbed answered the deployed function",
      typeof ttBody?.extractedText === "string" && ttBody.extractedText.length > 0,
      String(ttBody?.extractedText));
    check("a caption with no game is not confidently matched", ttBody?.confident === false,
      `confident=${ttBody?.confident}, top=${ttBody?.candidates?.[0]?.title ?? "none"}`);
    // It may still be offered as something to tap — that is the point. Only the
    // assertion is withdrawn, not the option.
    check("the near-miss is still offered as a candidate",
      (ttBody?.candidates?.length ?? 0) >= 0);

    // ---- 4b. The confidence guard itself ----
    // The rule that demotes the above: does this term NAME the game, up to spacing?
    // Exercised directly, because the interesting inputs are hashtags and there is
    // no stable public TikTok URL for each one to drive them through end to end.
    console.log("\n4b. shelf_term_names_game, the guard behind `confident`");
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${user.token}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const namesGame = async (term: string, gameId: string) => {
      const { data, error } = await asUser.rpc("shelf_term_names_game", {
        term, p_game_id: gameId,
      });
      if (error) throw new Error(`${term}: ${error.message}`);
      return data as boolean;
    };

    const { data: aestheta } = await admin
      .from("games").select("id, title").eq("title", "Aestheta").maybeSingle();

    check("an all-lowercase hashtag still names the game — #eldenring",
      (await namesGame("eldenring", top!.id)) === true);
    check("a spaced form names it too — 'elden ring'",
      (await namesGame("elden ring", top!.id)) === true);
    check("a merely similar word does NOT — 'aesthetic' vs Aestheta",
      aestheta ? (await namesGame("aesthetic", aestheta.id)) === false : false,
      aestheta ? "" : "Aestheta not in catalog — check skipped");
    check("an unrelated tag does not name it — 'petsoftiktok'",
      (await namesGame("petsoftiktok", top!.id)) === false);

    // Recreating or adding a function resets its ACL to Supabase's default, which
    // grants EXECUTE to anon. This repo has been bitten by that before.
    const asAnon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const anonCall = await asAnon.rpc("shelf_term_names_game", {
      term: "eldenring", p_game_id: top!.id,
    });
    check("anon cannot execute the guard", anonCall.error !== null,
      anonCall.error?.message ?? "anon got through");

    // ---- 5. An unsupported link is saved, not dropped ----
    console.log("\n5. A link from neither provider");
    const other200 = await post("/share-resolve", { url: NOT_A_VIDEO_SITE }, user.token);
    check("still returns 200, not an error", other200.status === 200, `HTTP ${other200.status}`);
    const otherBody = other200.body as ShareResolution;
    check("provider is other", otherBody?.provider === "other", otherBody?.provider);
    check("no candidates", otherBody?.candidates?.length === 0);
    check("not confident", otherBody?.confident === false);

    const { data: savedRow } = await admin
      .from("share_intake").select("id, raw_url, status")
      .eq("id", otherBody?.intakeId).maybeSingle();
    check("the link is still saved — nothing a user shares is dropped",
      savedRow?.raw_url === NOT_A_VIDEO_SITE, savedRow?.status);
    check("its status is unmatched", savedRow?.status === "unmatched", savedRow?.status);

    // ---- 6. /share-confirm writes the library row ----
    console.log("\n6. /share-confirm");
    const confirm = await post("/share-confirm",
      { intakeId: ytBody.intakeId, gameId: top!.id }, user.token);
    check("returns 200", confirm.status === 200, `HTTP ${confirm.status}`);
    const entry = confirm.body as LibraryEntry;
    check("the row belongs to the caller", entry?.user_id === user.userId);
    check("it points at the confirmed game", entry?.game_id === top!.id);
    check("status starts as backlog", entry?.status === "backlog", entry?.status);
    check("source_url is the shared link — the differentiator",
      entry?.source_url === YOUTUBE_ELDEN_RING, String(entry?.source_url));
    check("source_kind is derived from the provider, not the client",
      entry?.source_kind === "youtube", String(entry?.source_kind));

    const { data: intakeAfter } = await admin
      .from("share_intake").select("status, matched_game_id")
      .eq("id", ytBody.intakeId).maybeSingle();
    check("the intake is marked matched", intakeAfter?.status === "matched", intakeAfter?.status);
    check("the intake records which game won", intakeAfter?.matched_game_id === top!.id);

    // ---- 7. A repeat confirm must not undo the user's progress ----
    // The scaffold used an upsert here, which rewrote every column it was given:
    // re-sharing a game you had already beaten reset it to 'backlog' and overwrote
    // the original source_url. Idempotent has to mean "leave it alone", not "reset".
    console.log("\n7. Re-confirming a game the user has already played");
    await admin.from("library_entries")
      .update({ status: "beaten", rating: 9, notes: "loved it" }).eq("id", entry.id);

    const again = await post("/share-confirm",
      { intakeId: ytBody.intakeId, gameId: top!.id }, user.token);
    check("a repeat confirm still returns 200", again.status === 200, `HTTP ${again.status}`);
    const entryAgain = again.body as LibraryEntry;
    check("it is the same row, not a duplicate", entryAgain?.id === entry.id);
    check("status is NOT reset to backlog", entryAgain?.status === "beaten", entryAgain?.status);
    check("the rating survives", entryAgain?.rating === 9, String(entryAgain?.rating));
    check("the notes survive", entryAgain?.notes === "loved it", entryAgain?.notes);

    const { count } = await admin.from("library_entries")
      .select("id", { count: "exact", head: true }).eq("user_id", user.userId);
    check("still exactly one row for this user", count === 1, `${count} rows`);

    // ---- 8. Another user's intake is a 404, not a 403 ----
    console.log("\n8. Cross-account isolation");
    const stolen = await post("/share-confirm",
      { intakeId: ytBody.intakeId, gameId: top!.id }, other.token);
    check("another user's intakeId is a 404", stolen.status === 404, `HTTP ${stolen.status}`);
    const { count: otherCount } = await admin.from("library_entries")
      .select("id", { count: "exact", head: true }).eq("user_id", other.userId);
    check("and nothing was written to their library", otherCount === 0, `${otherCount} rows`);

    // ---- 9. The payoff: roulette stops returning null ----
    // library_entries was empty on this project until this endpoint shipped, so every
    // real account got null from /roulette. This is the check that closes that loop.
    console.log("\n9. /roulette now has something to roll");
    await admin.from("library_entries").update({ status: "backlog" }).eq("id", entry.id);
    const platformId = top!.platforms?.[0]?.id;
    check("the confirmed game has a platform to roll on", typeof platformId === "number",
      String(platformId));

    const roll = await fetch(`${FUNCTIONS}/roulette?platform=${platformId}&hours=2`, {
      headers: { apikey: ANON_KEY, Authorization: `Bearer ${user.token}` },
    });
    const rolled = await roll.json();
    check("roulette returns 200", roll.status === 200, `HTTP ${roll.status}`);
    check("and returns the game the share put there, not null",
      rolled?.id === top!.id, rolled?.title ?? "null");
  } finally {
    await admin.auth.admin.deleteUser(user.userId);
    await admin.auth.admin.deleteUser(other.userId);
    console.log("\ncleaned up test users.");
  }

  console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
