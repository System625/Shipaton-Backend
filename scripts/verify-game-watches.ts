// Exercises the Release-Day Tracker end to end (Session B of the Events build,
// docs/research/events-screen.md §4): the game_watches table and its RLS, the
// watcher_count aggregate, the deployed /games/:id fields, the release-day sweep
// that turns a watch into a notification, and the push batch that was fixed
// alongside it.
//
// game_watches itself is driven through real signed JWTs, same reasoning as
// verify-wishlist.ts -- the service-role client bypasses RLS and would pass those
// checks whether the policy existed or not. The sweep and push-batch checks use
// the admin client and the service-role bearer deliberately, because that is
// genuinely who calls them in production (game-release-sweep and push-sweep both
// check for the service role key, not a user session).
//
// Creates three users and three throwaway catalog rows, all removed at the end.
// Safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUp, removeAccounts, makeChecker, RUN, type Account } from "./social-accounts.ts";

const { check, finish } = makeChecker();

const SUPABASE_URL = required("SUPABASE_URL");
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
const today = new Date().toISOString().slice(0, 10);

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

/** Calls a deployed sweep function the way pg_cron does: bearer = service role key. */
async function callSweep(name: string, auth: string | null): Promise<{ status: number; body: any }> {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: "POST",
    headers: auth ? { Authorization: auth } : {},
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  console.log("\nGame watches / Release-Day Tracker verification\n");

  // ---- Throwaway catalog rows ----
  // gDay: an announced, day-precise release dated today -- the sweep should fire.
  // gPlaceholder: also dated today, but with no release_precision -- the guard
  // 20260917130000 exists for exactly this shape, and it must stay silent.
  // gFuture: unrelated to the sweep, just something for the plain watch/RLS checks.
  const { data: rows, error: insertError } = await admin.from("games").insert([
    { title: `Verify Release Day ${RUN}`, match_title: `verify release day ${RUN}`,
      release_date: today, release_precision: "day" },
    { title: `Verify Placeholder Day ${RUN}`, match_title: `verify placeholder day ${RUN}`,
      release_date: today, release_precision: null },
    { title: `Verify Future Game ${RUN}`, match_title: `verify future game ${RUN}`,
      release_date: "2099-01-01", release_precision: "day" },
  ]).select("id, title");
  if (insertError || rows?.length !== 3) throw new Error(`seeding test games: ${insertError?.message}`);
  const [gDay, gPlaceholder, gFuture] = rows;

  const alice = await signUp("gwa");
  const bob   = await signUp("gwb");
  const carol = await signUp("gwc");
  const anon  = createClient(SUPABASE_URL, required("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    // ---- 1. Watching a game ----
    console.log("1. Watching a game");
    const { data: watched, error: watchError } = await alice.client.from("game_watches")
      .insert({ game_id: gFuture.id }).select().single();
    check("insert with only game_id succeeds", !watchError, watchError?.message);
    check("user_id defaults to the caller", watched?.user_id === alice.userId);
    check("created_at is stamped", typeof watched?.created_at === "string");

    const { error: dupError } = await alice.client.from("game_watches")
      .insert({ game_id: gFuture.id });
    check("watching the same game twice is refused (23505)", dupError?.code === "23505", dupError?.code);

    const { error: fkError } = await alice.client.from("game_watches")
      .insert({ game_id: "00000000-0000-0000-0000-000000000000" });
    check("a game id not in the catalog is refused (23503)", fkError?.code === "23503", fkError?.code);

    // ---- 2. watcher_count is a real aggregate, not RLS-scoped ----
    console.log("\n2. watcher_count");
    const { data: countAliceOnly } = await bob.client
      .rpc("shelf_game_watcher_count", { p_game_id: gFuture.id });
    check("counts the one existing watcher", Number(countAliceOnly) === 1, String(countAliceOnly));

    await bob.client.from("game_watches").insert({ game_id: gFuture.id });
    const { data: countBoth } = await carol.client
      .rpc("shelf_game_watcher_count", { p_game_id: gFuture.id });
    check("counts across users, not just the caller's own row", Number(countBoth) === 2, String(countBoth));

    const { data: countZero } = await alice.client
      .rpc("shelf_game_watcher_count", { p_game_id: gPlaceholder.id });
    check("an unwatched game counts zero", Number(countZero) === 0, String(countZero));

    // ---- 3. Isolation ----
    console.log("\n3. One person's watch list is invisible to everyone else");
    const { data: bobSees } = await bob.client.from("game_watches")
      .select("game_id").eq("user_id", alice.userId);
    check("bob cannot read alice's watch rows through PostgREST", (bobSees?.length ?? 0) === 0,
      `${bobSees?.length} rows`);
    const { error: forgeError } = await bob.client.from("game_watches")
      .insert({ user_id: alice.userId, game_id: gDay.id });
    check("bob cannot watch a game on alice's behalf", !!forgeError, forgeError?.code);

    const { data: anonSees } = await anon.from("game_watches").select("game_id");
    check("anon reads nothing", (anonSees?.length ?? 0) === 0);
    const { error: anonWriteError } = await anon.from("game_watches")
      .insert({ user_id: alice.userId, game_id: gDay.id });
    check("anon cannot write", !!anonWriteError, anonWriteError?.code);
    const { error: anonCountError } = await anon
      .rpc("shelf_game_watcher_count", { p_game_id: gFuture.id });
    check("anon cannot execute shelf_game_watcher_count", !!anonCountError, anonCountError?.message);

    // ---- 4. Unwatching ----
    console.log("\n4. Unwatching");
    await bob.client.from("game_watches").delete().eq("game_id", gFuture.id);
    const { data: countAfterUnwatch } = await alice.client
      .rpc("shelf_game_watcher_count", { p_game_id: gFuture.id });
    check("watcher_count drops when someone unwatches", Number(countAfterUnwatch) === 1,
      String(countAfterUnwatch));

    // ---- 5. GET /games/:id carries watching + watcherCount ----
    console.log("\n5. The deployed /games/:id route");
    const aliceView = await callGames(alice, gFuture.id);
    check("watching is true for the watcher", aliceView.body?.watching === true,
      JSON.stringify(aliceView.body));
    check("watcherCount matches the aggregate", aliceView.body?.watcherCount === 1,
      aliceView.body?.watcherCount);
    const bobView = await callGames(bob, gFuture.id);
    check("watching is false for someone who unwatched", bobView.body?.watching === false);
    check("watcherCount is the same for every viewer", bobView.body?.watcherCount === 1);

    // ---- 6. The release-day sweep ----
    console.log("\n6. The release-day sweep");
    await alice.client.from("game_watches").insert({ game_id: gDay.id });
    await bob.client.from("game_watches").insert({ game_id: gDay.id });
    await carol.client.from("game_watches").insert({ game_id: gPlaceholder.id });

    const unauthedSweep = await callSweep("game-release-sweep", null);
    check("the sweep refuses a caller with no service-role bearer", unauthedSweep.status === 401,
      String(unauthedSweep.status));
    const userSweep = await callSweep("game-release-sweep",
      `Bearer ${(await alice.client.auth.getSession()).data.session!.access_token}`);
    check("and refuses a real user session too", userSweep.status === 401, String(userSweep.status));

    const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");
    const sweep = await callSweep("game-release-sweep", `Bearer ${serviceKey}`);
    check("the sweep runs for the service role", sweep.status === 200, JSON.stringify(sweep.body));
    check("it wrote exactly the two watchers of the day-precise release",
      sweep.body?.swept === 2, JSON.stringify(sweep.body));

    const aliceInbox = (await alice.client.rpc("shelf_notifications", {})).data as any[];
    const aliceRelease = aliceInbox.find((n) => n.kind === "game_release");
    check("alice is notified for the release she watches", !!aliceRelease);
    check("it names the game, not an actor", aliceRelease?.game_title === gDay.title &&
      aliceRelease?.actor_id === null, JSON.stringify(aliceRelease));
    check("it points at the right game_id", aliceRelease?.game_id === gDay.id);

    const bobRelease = ((await bob.client.rpc("shelf_notifications", {})).data as any[])
      .find((n) => n.kind === "game_release");
    check("bob is notified too", !!bobRelease);

    const carolInbox = (await carol.client.rpc("shelf_notifications", {})).data as any[];
    check("carol, watching only the placeholder-dated game, gets nothing",
      carolInbox.filter((n) => n.kind === "game_release").length === 0,
      JSON.stringify(carolInbox));

    // ---- 7. The sweep is idempotent ----
    console.log("\n7. Running the sweep again");
    const secondSweep = await callSweep("game-release-sweep", `Bearer ${serviceKey}`);
    check("a repeat sweep rings nobody's bell twice", secondSweep.body?.swept === 0,
      JSON.stringify(secondSweep.body));
    const aliceInboxAgain = (await alice.client.rpc("shelf_notifications", {})).data as any[];
    check("alice still has exactly one game_release notification",
      aliceInboxAgain.filter((n) => n.kind === "game_release").length === 1,
      JSON.stringify(aliceInboxAgain));

    // ---- 8. A client still cannot manufacture one ----
    console.log("\n8. A client cannot write the table directly");
    const { error: clientForged } = await alice.client.from("notifications").insert({
      user_id: alice.userId, kind: "game_release", game_id: gDay.id,
    });
    check("no INSERT policy covers game_release either", !!clientForged, clientForged?.code ?? "no error");

    const { error: shapelessError } = await admin.from("notifications").insert({
      user_id: alice.userId, kind: "game_release", game_id: null,
    });
    check("game_release_has_game rejects a game_release row with no game_id",
      !!shapelessError?.message?.includes("game_release_has_game"), shapelessError?.message);

    // ---- 9. The push batch sees game_release rows (the inner-join regression) ----
    console.log("\n9. The push batch (shelf_next_push_batch)");
    const { data: batch, error: batchError } = await admin.rpc("shelf_next_push_batch", { p_limit: 500 });
    if (batchError) throw new Error(`shelf_next_push_batch: ${batchError.message}`);
    const batchRows = (batch ?? []) as any[];
    const aliceBatchRow = batchRows.find((r) => r.id === aliceRelease.id);
    check("alice's game_release notification is in the batch, not dropped by the join",
      !!aliceBatchRow, `${batchRows.length} row(s) in batch`);
    check("it carries the game title, with no actor to name",
      aliceBatchRow?.game_title === gDay.title && aliceBatchRow?.actor_display_name === null,
      JSON.stringify(aliceBatchRow));

    const { error: authedBatchError } = await alice.client.rpc("shelf_next_push_batch", { p_limit: 5 });
    check("authenticated still cannot call it directly", !!authedBatchError, authedBatchError?.message);
  } finally {
    await removeAccounts([alice, bob, carol]);
    // Cascades take game_watches and any notifications pointing at these games
    // with them.
    await admin.from("games").delete().in("id", [gDay.id, gPlaceholder.id, gFuture.id]);
    console.log("\ncleaned up test users and catalog rows.");
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
