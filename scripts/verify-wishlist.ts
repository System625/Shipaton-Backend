// Exercises the wishlist ("Saved") against real signed JWTs.
//
// There is no edge function: the app reads and writes `wishlist_entries` straight
// through PostgREST, the same way it already syncs `library_entries`. So everything
// that matters is the policy and the constraints, and the only honest way to check
// those is from real sessions -- the service role in supabase-admin.ts bypasses RLS
// and would pass every one of these checks whether the policy existed or not.
//
// Uses two real catalog games (read only) and creates two users, removed at the end.
// Safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUp, removeAccounts, makeChecker } from "./social-accounts.ts";

const { check, finish } = makeChecker();

async function main() {
  console.log(`\nWishlist verification\n`);

  const { data: games, error: gamesError } = await admin.from("games")
    .select("id, title").not("release_date", "is", null).limit(2);
  if (gamesError || games?.length !== 2) throw new Error(`catalog games: ${gamesError?.message}`);
  const [g1, g2] = games;

  const alice = await signUp("wa");
  const bob   = await signUp("wb");
  const anon  = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let aliceRemoved = false;

  try {
    // ---- 1. Saving a game ----
    console.log("1. Saving a game");
    const { data: saved, error: saveError } = await alice.client.from("wishlist_entries")
      .insert({ game_id: g1.id }).select().single();
    check("insert with only game_id succeeds", !saveError, saveError?.message);
    check("user_id defaults to the caller", saved?.user_id === alice.userId);
    check("the reminder is armed by default", saved?.reminder_enabled === true);
    check("added_at is stamped", typeof saved?.added_at === "string");

    const { error: dupError } = await alice.client.from("wishlist_entries")
      .insert({ game_id: g1.id });
    check("saving the same game twice is refused (23505)", dupError?.code === "23505",
      dupError?.code);

    const { error: fkError } = await alice.client.from("wishlist_entries")
      .insert({ game_id: "00000000-0000-0000-0000-000000000000" });
    check("a game id not in the catalog is refused (23503)", fkError?.code === "23503",
      fkError?.code);

    // ---- 2. Reading it back the way the app will ----
    console.log("\n2. Reading it back");
    await alice.client.from("wishlist_entries").insert({ game_id: g2.id });
    const { data: list, error: listError } = await alice.client.from("wishlist_entries")
      .select("game_id, reminder_enabled, added_at, games(title, release_date)")
      .order("added_at", { ascending: false });
    check("the owner reads both saved games", !listError && list?.length === 2,
      listError?.message ?? `${list?.length} rows`);
    const first = list?.find((r) => r.game_id === g1.id) as any;
    check("the game can be embedded in the same request", first?.games?.title === g1.title,
      first?.games?.title);
    check("the embed carries the release date the reminder needs",
      typeof first?.games?.release_date === "string", first?.games?.release_date);

    // ---- 3. The reminder toggle ----
    console.log("\n3. Reminder toggle");
    await alice.client.from("wishlist_entries").update({ reminder_enabled: false })
      .eq("game_id", g1.id);
    const { data: toggled } = await alice.client.from("wishlist_entries")
      .select("reminder_enabled").eq("game_id", g1.id).single();
    check("turning the reminder off persists", toggled?.reminder_enabled === false);

    // ---- 4. Saved and owned are independent ----
    console.log("\n4. Saved and owned at the same time");
    const { error: libError } = await alice.client.from("library_entries")
      .insert({ user_id: alice.userId, game_id: g1.id, status: "backlog", source_kind: "search" });
    check("a saved game can also be added to the library", !libError, libError?.message);
    const { data: lib } = await alice.client.from("library_entries").select("game_id, status");
    check("the library holds only the library row, never a wishlist status",
      lib?.length === 1 && lib[0].status === "backlog", JSON.stringify(lib));
    const { count: stillSaved } = await alice.client.from("wishlist_entries")
      .select("*", { count: "exact", head: true });
    check("adding to the library does not touch the wishlist", stillSaved === 2, `${stillSaved}`);

    // ---- 5. Another account ----
    console.log("\n5. Another signed-in account");
    const { data: bobSees } = await bob.client.from("wishlist_entries").select("game_id");
    check("bob sees none of alice's saved games", (bobSees?.length ?? -1) === 0,
      `${bobSees?.length} rows`);

    const { error: forgeError } = await bob.client.from("wishlist_entries")
      .insert({ user_id: alice.userId, game_id: g2.id });
    check("bob cannot save a game onto alice's wishlist", !!forgeError, forgeError?.code);

    await bob.client.from("wishlist_entries").update({ reminder_enabled: true })
      .eq("user_id", alice.userId);
    await bob.client.from("wishlist_entries").delete().eq("user_id", alice.userId);
    const { data: afterBob } = await admin.from("wishlist_entries")
      .select("game_id, reminder_enabled").eq("user_id", alice.userId);
    check("bob's delete reached nothing", afterBob?.length === 2, `${afterBob?.length} rows`);
    check("bob's update reached nothing",
      afterBob?.find((r) => r.game_id === g1.id)?.reminder_enabled === false);

    const { error: bobOwnError } = await bob.client.from("wishlist_entries")
      .insert({ game_id: g1.id });
    check("bob can save the same game on his own wishlist", !bobOwnError, bobOwnError?.message);

    // ---- 6. Signed out ----
    console.log("\n6. Signed out (anon key only)");
    const { data: anonSees } = await anon.from("wishlist_entries").select("game_id");
    check("anon reads nothing", (anonSees?.length ?? 0) === 0);
    const { error: anonWriteError } = await anon.from("wishlist_entries")
      .insert({ user_id: alice.userId, game_id: g2.id });
    check("anon cannot write", !!anonWriteError, anonWriteError?.code);

    // ---- 7. Removing ----
    console.log("\n7. Removing");
    await alice.client.from("wishlist_entries").delete().eq("game_id", g2.id);
    const { data: left } = await alice.client.from("wishlist_entries").select("game_id");
    check("the owner can unsave a game", left?.length === 1 && left[0].game_id === g1.id);

    await removeAccounts([alice]);
    aliceRemoved = true;
    const { count: orphans } = await admin.from("wishlist_entries")
      .select("*", { count: "exact", head: true }).eq("user_id", alice.userId);
    check("deleting the account deletes its wishlist", orphans === 0, `${orphans}`);
  } finally {
    await removeAccounts(aliceRemoved ? [bob] : [alice, bob]);
    console.log("\ncleaned up test users.");
  }

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
