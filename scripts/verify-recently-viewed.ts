// Exercises "recently viewed" against real signed JWTs, through the edge function
// the app will actually call.
//
// Driven from real sessions rather than the service role for the usual reason: the
// client in supabase-admin.ts bypasses RLS, so it would pass the isolation checks
// whether the policy existed or not. Section 4 is the one that matters most -- this
// table records what someone BROWSED, which is more revealing than what they own.
//
// Creates two users and removes them at the end; the cascade takes their history
// with them. Reads real catalog rows, writes nothing that outlives the run.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUp, removeAccounts, makeChecker, type Account } from "./social-accounts.ts";

const { check, finish } = makeChecker();

const FUNCTIONS = `${required("SUPABASE_URL")}/functions/v1`;

/** Calls the deployed `games` function as a real signed-in user. */
async function callGames(acct: Account, path: string): Promise<{ status: number; body: any }> {
  const { data: session } = await acct.client.auth.getSession();
  const res = await fetch(`${FUNCTIONS}/games/${path}`, {
    headers: {
      Authorization: `Bearer ${session.session!.access_token}`,
      apikey: required("SUPABASE_ANON_KEY"),
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  console.log("\nRecently viewed verification\n");

  // Real catalog rows. `cover_url` is not required by anything here; the point is
  // that these are rows the app could genuinely open.
  const { data: games, error: gamesError } = await admin
    .from("games").select("id, title")
    .not("release_date", "is", null)
    .order("total_rating_count", { ascending: false })
    .limit(4);
  if (gamesError || games?.length !== 4) throw new Error(`catalog games: ${gamesError?.message}`);
  const [g1, g2, g3, g4] = games;

  const alice = await signUp("rva");
  const bob = await signUp("rvb");

  try {
    // ---- 1. Opening a game records it ----
    console.log("1. Opening a game records the view");
    const empty = await callGames(alice, "recently-viewed");
    check("a new account's history is empty", Array.isArray(empty.body) && empty.body.length === 0,
      `${empty.status}, ${Array.isArray(empty.body) ? empty.body.length : "not an array"} rows`);

    const detail = await callGames(alice, g1.id);
    check("GET /games/:id still returns the game", detail.status === 200 && detail.body?.id === g1.id,
      detail.body?.title ?? `status ${detail.status}`);

    // The write is a background task, so it is not guaranteed to have landed by the
    // time the response arrives. This is the one place the test has to wait on the
    // runtime rather than on an awaited promise.
    await new Promise((r) => setTimeout(r, 1500));

    const afterOne = await callGames(alice, "recently-viewed");
    check("the opened game is in the history", afterOne.body?.[0]?.id === g1.id,
      afterOne.body?.[0]?.title ?? "nothing recorded");

    // ---- 2. The CatalogGame contract ----
    // The reason this route exists at all instead of the app calling the RPC: two of
    // these fields are derived in toCatalogGame() and are not columns. An app reading
    // the table directly gets neither, and a missing colorKey renders as the same
    // grey for every game with no error on either side -- which has already happened
    // once on this project.
    console.log("\n2. Rows carry the full CatalogGame contract");
    const row = afterOne.body?.[0] ?? {};
    check("carries `abbreviation` (derived, not a column)", typeof row.abbreviation === "string", row.abbreviation);
    check("carries `colorKey` (derived, not a column)", typeof row.colorKey === "string", row.colorKey);
    check("carries `platforms` as an array", Array.isArray(row.platforms), `${row.platforms?.length} platform(s)`);
    check("carries `viewedAt`", typeof row.viewedAt === "string" && !Number.isNaN(Date.parse(row.viewedAt)), row.viewedAt);

    // ---- 3. Re-opening moves, it does not duplicate ----
    console.log("\n3. Re-opening a game moves it rather than adding a row");
    await callGames(alice, g2.id);
    await callGames(alice, g3.id);
    await new Promise((r) => setTimeout(r, 1500));
    let history = (await callGames(alice, "recently-viewed")).body as any[];
    check("three distinct games, newest first", history.map((r) => r.id).join() === [g3.id, g2.id, g1.id].join(),
      history.map((r) => r.title).join(" | "));

    await callGames(alice, g1.id); // the oldest, opened again
    await new Promise((r) => setTimeout(r, 1500));
    history = (await callGames(alice, "recently-viewed")).body as any[];
    check("re-opened game moves to the top", history[0]?.id === g1.id, history[0]?.title);
    check("and does NOT become a second row", history.length === 3, `${history.length} rows`);

    // ---- 4. It is private ----
    // Stricter than the library on purpose. Browsing history is not feed data and
    // must not become it.
    console.log("\n4. One person's history is invisible to everyone else");
    await callGames(bob, g4.id);
    await new Promise((r) => setTimeout(r, 1500));
    const bobHistory = (await callGames(bob, "recently-viewed")).body as any[];
    check("bob sees only his own view", bobHistory.length === 1 && bobHistory[0].id === g4.id,
      bobHistory.map((r) => r.title).join(" | "));

    const { data: leak } = await bob.client.from("recently_viewed").select("*");
    check("bob cannot read alice's rows through PostgREST", (leak ?? []).every((r: any) => r.user_id === bob.userId),
      `${(leak ?? []).length} row(s) visible, all his own`);

    const { error: writeOther } = await bob.client.from("recently_viewed")
      .insert({ user_id: alice.userId, game_id: g1.id });
    check("bob cannot write INTO alice's history", writeOther != null, writeOther?.message ?? "INSERT SUCCEEDED");

    const anon = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: anonRpc } = await anon.rpc("shelf_recently_viewed", { max_results: 5 });
    check("anon cannot execute shelf_recently_viewed", anonRpc != null, anonRpc?.message ?? "EXECUTE ALLOWED");

    // ---- 5. `?track=0` ----
    console.log("\n5. `?track=0` fetches without recording");
    const before = ((await callGames(bob, "recently-viewed")).body as any[]).length;
    await callGames(bob, `${g1.id}?track=0`);
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await callGames(bob, "recently-viewed")).body as any[];
    check("history is unchanged", after.length === before, `${before} -> ${after.length}`);
    check("and the untracked game is not in it", !after.some((r) => r.id === g1.id));

    // ---- 6. The 50-row cap ----
    // Written through the RPC rather than 55 HTTP calls: the cap is the function's
    // job, and this is checking the function, not the route. One call per view also
    // means one transaction per view, and now() is the transaction timestamp -- so
    // the rows really do carry distinct, increasing times and "newest 50" is well
    // defined. Batching them into a single statement would give every row the same
    // timestamp and make this check flap on the `game_id` tiebreak instead.
    console.log("\n6. The history stays capped at 50");
    const { data: many, error: manyError } = await admin
      .from("games").select("id").limit(60);
    if (manyError || (many ?? []).length < 55) throw new Error("need 55+ catalog rows for the cap check");

    for (const g of many!) {
      const { error } = await alice.client.rpc("shelf_track_game_view", { p_game_id: g.id });
      if (error) throw new Error(`shelf_track_game_view: ${error.message}`);
    }
    const { count } = await alice.client
      .from("recently_viewed").select("*", { count: "exact", head: true });
    check("no more than 50 rows survive", (count ?? 0) <= 50, `${count} rows after ${many!.length} views`);

    const capped = (await callGames(alice, "recently-viewed?limit=100")).body as any[];
    check("the newest view is still at the top", capped[0]?.id === many![many!.length - 1].id,
      capped[0]?.title);
  } finally {
    await removeAccounts([alice, bob]);
  }

  // AFTER the finally, never inside the try: finish() calls process.exit(), which
  // skips pending finally blocks outright. Calling it above left two test accounts
  // and 51 history rows in the production project on the first run of this script.
  finish();
}

main();
