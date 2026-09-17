// Exercises seasonal challenges end to end, through real signed JWTs -- same
// reasoning as verify-recently-viewed.ts: the service-role client in
// supabase-admin.ts bypasses RLS, so only a real session can prove isolation holds.
//
// Also exercises the library_entries finished_at/status trigger added in the same
// migration (20260917110000_seasonal_challenges.sql), since shelf_challenges()'s
// progress count is meaningless if that invariant does not hold.
//
// Creates two users and two throwaway challenges, removes all of it at the end.

import { admin } from "./supabase-admin.ts";
import { signUp, removeAccounts, makeChecker, RUN } from "./social-accounts.ts";

const { check, finish } = makeChecker();

const dayOffset = (n: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function main() {
  console.log("\nSeasonal challenges verification\n");

  // ---- Real catalog rows ----
  const { data: rpgGames, error: rpgError } = await admin
    .from("games").select("id, title, genres")
    .contains("genres", ["Role-playing (RPG)"])
    .limit(4);
  if (rpgError || (rpgGames ?? []).length < 4) throw new Error(`need 4 RPG games: ${rpgError?.message}`);
  const [rpg1, rpg2, rpg3, rpg4] = rpgGames!;

  const { data: genreSample, error: nonRpgError } = await admin
    .from("games").select("id, title, genres")
    .not("genres", "eq", "{}")
    .limit(200);
  if (nonRpgError) throw new Error(`sampling games: ${nonRpgError.message}`);
  const notRpg = (genreSample ?? []).find((g) => !(g.genres as string[]).includes("Role-playing (RPG)"));
  if (!notRpg) throw new Error("need a non-RPG game in the first 200 sampled rows");

  // ---- Throwaway challenges spanning active/upcoming/ended ----
  const { data: challenges, error: chError } = await admin
    .from("seasonal_challenges")
    .insert([
      {
        title: `Verify active ${RUN}`, description: "test",
        start_date: dayOffset(-5), end_date: dayOffset(5),
        criteria: { genres: ["Role-playing (RPG)"], count: 3 },
      },
      {
        title: `Verify upcoming ${RUN}`, description: "test",
        start_date: dayOffset(10), end_date: dayOffset(20),
        criteria: { genres: ["Role-playing (RPG)"], count: 1 },
      },
      {
        title: `Verify ended ${RUN}`, description: "test",
        start_date: dayOffset(-60), end_date: dayOffset(-30),
        criteria: { genres: ["Role-playing (RPG)"], count: 1 },
      },
    ])
    .select("id, title");
  if (chError) throw new Error(`seeding challenges: ${chError.message}`);
  const active = challenges!.find((c) => c.title.startsWith("Verify active"))!;
  const upcoming = challenges!.find((c) => c.title.startsWith("Verify upcoming"))!;
  const ended = challenges!.find((c) => c.title.startsWith("Verify ended"))!;

  const alice = await signUp("cha");
  const bob = await signUp("chb");

  try {
    // ---- 1. Malformed criteria is rejected at write time ----
    console.log("1. The criteria shape is enforced, not just hoped for");
    const { error: badCount } = await admin.from("seasonal_challenges").insert({
      title: `bad count ${RUN}`, start_date: dayOffset(0), end_date: dayOffset(1),
      criteria: { genres: ["Shooter"], count: 0 },
    });
    check("count <= 0 is rejected", badCount != null, badCount?.message ?? "INSERT SUCCEEDED");

    const { error: badGenres } = await admin.from("seasonal_challenges").insert({
      title: `bad genres ${RUN}`, start_date: dayOffset(0), end_date: dayOffset(1),
      criteria: { genres: [], count: 1 },
    });
    check("empty genres array is rejected", badGenres != null, badGenres?.message ?? "INSERT SUCCEEDED");

    // A missing key, not just an empty/wrong-typed one: `criteria->'genres'` is SQL
    // NULL when absent, which makes `jsonb_typeof(...) = 'array'` NULL rather than
    // FALSE -- and a CHECK constraint passes on NULL. The `?` existence checks in
    // the migration exist specifically to close this.
    const { error: missingKey } = await admin.from("seasonal_challenges").insert({
      title: `missing key ${RUN}`, start_date: dayOffset(0), end_date: dayOffset(1),
      criteria: { count: 1 },
    });
    check("criteria missing the genres key entirely is rejected", missingKey != null,
      missingKey?.message ?? "INSERT SUCCEEDED");

    // ---- 2. The finished_at / status trigger ----
    console.log("\n2. library_entries keeps status and finished_at in sync");
    const { data: playing, error: insErr } = await alice.client
      .from("library_entries")
      .insert({ user_id: alice.userId, game_id: rpg1.id, status: "playing" })
      .select("id, finished_at").single();
    if (insErr) throw new Error(`insert playing: ${insErr.message}`);
    check("a 'playing' row has no finished_at", playing!.finished_at === null, String(playing!.finished_at));

    const { data: beaten, error: updErr } = await alice.client
      .from("library_entries").update({ status: "beaten" })
      .eq("id", playing!.id).select("finished_at").single();
    if (updErr) throw new Error(`update to beaten: ${updErr.message}`);
    check("moving to 'beaten' sets finished_at", beaten!.finished_at !== null, String(beaten!.finished_at));

    const { data: dropped, error: dropErr } = await alice.client
      .from("library_entries").update({ status: "dropped" })
      .eq("id", playing!.id).select("finished_at").single();
    if (dropErr) throw new Error(`update to dropped: ${dropErr.message}`);
    check("moving OFF 'beaten' clears finished_at", dropped!.finished_at === null, String(dropped!.finished_at));

    const { data: sneak, error: sneakErr } = await alice.client
      .from("library_entries")
      .insert({ user_id: alice.userId, game_id: rpg2.id, status: "backlog", finished_at: new Date().toISOString() })
      .select("finished_at").single();
    if (sneakErr) throw new Error(`insert sneak: ${sneakErr.message}`);
    check("a client-supplied finished_at is ignored unless status is 'beaten'",
      sneak!.finished_at === null, String(sneak!.finished_at));

    // ---- 3. Progress counts correctly ----
    console.log("\n3. Progress counts correctly against the active challenge");
    // rpg1: currently 'dropped' (from step 2). rpg2: currently 'backlog'.
    // Two more RPGs beaten now, inside the active window -> count 2 of target 3.
    for (const g of [rpg1, rpg3]) {
      const { error } = await alice.client.from("library_entries")
        .upsert({ user_id: alice.userId, game_id: g.id, status: "beaten" }, { onConflict: "user_id,game_id" });
      if (error) throw new Error(`beat ${g.title}: ${error.message}`);
    }
    // A non-RPG game, beaten in-window: must not count.
    { const { error } = await alice.client.from("library_entries")
        .upsert({ user_id: alice.userId, game_id: notRpg.id, status: "beaten" }, { onConflict: "user_id,game_id" });
      if (error) throw new Error(`beat non-RPG: ${error.message}`); }
    // An RPG beaten OUTSIDE the window (backdated explicitly): must not count.
    { const { error } = await alice.client.from("library_entries")
        .upsert({ user_id: alice.userId, game_id: rpg4.id, status: "beaten", finished_at: "2020-01-15T00:00:00Z" },
          { onConflict: "user_id,game_id" });
      if (error) throw new Error(`beat backdated RPG: ${error.message}`); }

    const { data: aliceRows, error: aliceErr } = await alice.client.rpc("shelf_challenges");
    if (aliceErr) throw new Error(`shelf_challenges: ${aliceErr.message}`);
    const aliceActive = (aliceRows as any[]).find((r) => r.id === active.id);
    check("status = 'active' for a challenge spanning today", aliceActive?.status === "active", aliceActive?.status);
    check("progress counts exactly the 2 in-window RPGs", aliceActive?.my_progress?.count === 2,
      JSON.stringify(aliceActive?.my_progress));
    check("target matches the seeded criteria", aliceActive?.my_progress?.target === 3, aliceActive?.my_progress?.target);

    const aliceUpcoming = (aliceRows as any[]).find((r) => r.id === upcoming.id);
    check("status = 'upcoming' for a future window", aliceUpcoming?.status === "upcoming", aliceUpcoming?.status);
    const aliceEnded = (aliceRows as any[]).find((r) => r.id === ended.id);
    check("status = 'ended' for a past window", aliceEnded?.status === "ended", aliceEnded?.status);

    // One more RPG completes the challenge.
    { const { error } = await alice.client.from("library_entries")
        .upsert({ user_id: alice.userId, game_id: rpg2.id, status: "beaten" }, { onConflict: "user_id,game_id" });
      if (error) throw new Error(`beat rpg2: ${error.message}`); }
    const { data: aliceRows2 } = await alice.client.rpc("shelf_challenges");
    const aliceActive2 = (aliceRows2 as any[]).find((r) => r.id === active.id);
    check("progress reaches the target after the third RPG", aliceActive2?.my_progress?.count === 3,
      JSON.stringify(aliceActive2?.my_progress));

    // ---- 4. Progress is per-user ----
    console.log("\n4. Progress is per-user, challenges are shared reference data");
    const { data: bobRows, error: bobErr } = await bob.client.rpc("shelf_challenges");
    if (bobErr) throw new Error(`bob shelf_challenges: ${bobErr.message}`);
    const bobActive = (bobRows as any[]).find((r) => r.id === active.id);
    check("bob sees the same challenge", bobActive != null, bobActive?.title);
    check("but with his own (zero) progress", bobActive?.my_progress?.count === 0, JSON.stringify(bobActive?.my_progress));

    // ---- 5. Access control ----
    console.log("\n5. Access control");
    const { error: writeAttempt } = await alice.client
      .from("seasonal_challenges")
      .insert({ title: "hijack", start_date: dayOffset(0), end_date: dayOffset(1), criteria: { genres: ["Shooter"], count: 1 } });
    check("authenticated cannot write a challenge (no INSERT policy)", writeAttempt != null,
      writeAttempt?.message ?? "INSERT SUCCEEDED");

    const { createClient } = await import("@supabase/supabase-js");
    const { required } = await import("./env.ts");
    const anon = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: anonRpc } = await anon.rpc("shelf_challenges");
    check("anon cannot execute shelf_challenges", anonRpc != null, anonRpc?.message ?? "EXECUTE ALLOWED");
    const { data: anonRead, error: anonReadErr } = await anon.from("seasonal_challenges").select("*");
    check("anon cannot read seasonal_challenges directly (RLS: no policy for anon)",
      anonReadErr != null || (anonRead ?? []).length === 0,
      anonReadErr?.message ?? `${(anonRead ?? []).length} row(s) visible`);
  } finally {
    await admin.from("seasonal_challenges").delete().in("id", [active.id, upcoming.id, ended.id]);
    await removeAccounts([alice, bob]);
  }

  finish();
}

main();
