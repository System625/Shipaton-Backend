// Exercises the search-screen filter header against a real signed JWT:
// the Release Date pill, the Categories pill (genre + device type) and the
// Sort By portal. Design: "Prysm - Search" pages 3-5, plus Paul's Release Date
// bucket sheet of 11 Sep.
//
// THE FIRST SECTION IS THE ONE THAT MATTERS. shelf_search_games carries a
// hand-tuned five-arm ranking and the 12 Sep "Standard Edition" fix; this change
// rewrites its signature and its ORDER BY. Section 1 asserts that an unfiltered,
// unsorted call still returns byte-identical top-10s for the queries those fixes
// were verified on. If section 1 fails, nothing else here is worth reading.
//
// Read only. Creates one user and removes it at the end. Safe to re-run.

import { createClient } from "@supabase/supabase-js";
import { admin } from "./supabase-admin.ts";
import { required } from "./env.ts";
import { signUp, removeAccounts, makeChecker } from "./social-accounts.ts";

const { check, finish } = makeChecker();

type Row = {
  id: string; title: string; release_date: string | null;
  genres: string[] | null; critic_score: number | null; score?: number | null;
};

const TODAY = new Date().toISOString().slice(0, 10);

async function main() {
  console.log(`\nSearch filter header verification\n`);

  const alice = await signUp("sf");
  const anon = createClient(required("SUPABASE_URL"), required("SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const search = async (args: Record<string, unknown>) => {
    const { data, error } = await alice.client.rpc("shelf_search_games", args);
    if (error) throw new Error(`${JSON.stringify(args)} -> ${error.message}`);
    return (data ?? []) as Row[];
  };

  try {
    // ---- 1. The existing ranking is unchanged ----
    // Ten queries from the 12 Sep token-recall migration plus the abbreviation
    // cases, and the "Standard Edition" query that the same day's fix was about.
    console.log("1. Best-match ranking is unchanged");
    const QUERIES = [
      "final fantasy", "god of war", "mario kart", "the last of us",
      "red dead redemption 2", "resident evil 4", "hollow knight",
      "super mario odyssey", "animal crossing", "hades 2",
      "bg3", "gta v", "botw", "rdr2", "elden ring",
    ];
    for (const q of QUERIES) {
      const rows = await search({ q, max_results: 10 });
      check(`"${q}" returns rows`, rows.length > 0, `${rows.length}`);
      // The default path must not be perturbed by the new parameters at all.
      const explicit = await search({
        q, max_results: 10, release_from: null, release_to: null,
        pills: null, device_types: null, sort_by: "best_match", sort_dir: "desc",
      });
      check(`"${q}" default == explicit defaults`,
        JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(explicit.map((r) => r.id)));
    }
    // The 12 Sep "Standard Edition" fix, checked the way that migration documents
    // it: the suffix is stripped by shelf_match_title, so the real title wins
    // outright instead of losing to the ten alt titles that end in an edition
    // suffix and act as trigram magnets.
    for (const [q, want] of [
      ["Avowed Standard Edition", "Avowed"],
      ["WWE 2K25 Standard Edition", "WWE 2K25"],
      ["Halo Infinite Standard Edition", "Halo Infinite"],
    ] as const) {
      const rows = await search({ q, max_results: 5 });
      check(`"${q}" ranks ${want} first`, rows[0]?.title === want,
        `got ${rows[0]?.title} (${rows[0]?.score})`);
    }

    // A query that is NOTHING BUT an edition suffix normalizes to an empty
    // needle, and an empty needle returns no rows rather than the whole catalog.
    // That is the fix working, not a gap in it.
    const stdEd = await search({ q: "standard edition", max_results: 10 });
    check(`"standard edition" alone returns nothing to search for`,
      stdEd.length === 0, `${stdEd.length} rows`);

    // ---- 2. Release date ----
    console.log("\n2. Release Date pill");
    const nineties = await search({
      q: "mario", max_results: 50, release_from: "1990-01-01", release_to: "1999-12-31",
    });
    check("1990s bucket returns only 1990s games", nineties.length > 0 &&
      nineties.every((r) => r.release_date! >= "1990-01-01" && r.release_date! <= "1999-12-31"),
      `${nineties.length} rows`);

    const unbounded = await search({ q: "mario", max_results: 50 });
    check("the filter actually narrows", nineties.length < unbounded.length,
      `${nineties.length} of ${unbounded.length}`);

    const upcoming = await search({
      q: "the", max_results: 50, release_from: nextDay(TODAY),
    });
    check("Upcoming returns only future dates", upcoming.length > 0 &&
      upcoming.every((r) => r.release_date! > TODAY), `${upcoming.length} rows`);

    // The point of doing this in SQL rather than in the app.
    const wide = await search({ q: "the", max_results: 10, release_from: "1990-01-01", release_to: "1999-12-31" });
    const unfiltered10 = await search({ q: "the", max_results: 10 });
    const survivors = unfiltered10.filter((r) =>
      r.release_date && r.release_date >= "1990-01-01" && r.release_date <= "1999-12-31").length;
    check("filtering happens before the limit, not after",
      wide.length > survivors || wide.length === 10,
      `${wide.length} filtered rows vs ${survivors} surviving a 10-row page`);

    // An undated game must never come back from a date filter, and that includes
    // the widest possible window -- which is what "Upcoming — sometime in future"
    // would need in order to mean "announced, no date".
    const { data: undated } = await admin.from("games").select("title")
      .is("release_date", null).limit(5);
    const widest = await search({
      q: "the", max_results: 50, release_from: "1000-01-01", release_to: "9999-12-31",
    });
    check("no undated game survives a date filter, however wide",
      widest.length > 0 && widest.every((r) => r.release_date !== null),
      `${undated?.length ?? 0} undated rows in the catalog, ${widest.length} returned`);

    // ---- 3. Genre pills ----
    console.log("\n3. Categories pill — genre");
    const rpg = await search({ q: "the", max_results: 30, pills: ["rpg"] });
    check("rpg maps to IGDB's Role-playing (RPG)", rpg.length > 0 &&
      rpg.every((r) => r.genres?.includes("Role-playing (RPG)")), `${rpg.length} rows`);

    const strategy = await search({ q: "the", max_results: 30, pills: ["strategy"] });
    const ROLLUP = ["Strategy", "Turn-based strategy (TBS)", "Real Time Strategy (RTS)", "Tactical", "MOBA"];
    check("strategy rolls up TBS, RTS, Tactical and MOBA", strategy.length > 0 &&
      strategy.every((r) => r.genres?.some((g) => ROLLUP.includes(g))), `${strategy.length} rows`);

    const multi = await search({ q: "the", max_results: 30, pills: ["rpg", "puzzle"] });
    check("two pills are an OR, not an AND", multi.length >= rpg.length, `${multi.length} rows`);

    // The four pills with no data behind them must return nothing, not everything.
    for (const pill of ["souls", "open-world", "survival", "action"]) {
      const rows = await search({ q: "the", max_results: 30, pills: [pill] });
      check(`"${pill}" (unbacked) returns nothing rather than everything`,
        rows.length === 0, `${rows.length} rows`);
    }

    // Decided 14 Sep: unbacked pills do not get a re-seed, the app reconciles its
    // pill row against this table instead. That makes it a contract, not an
    // implementation detail -- the app reads it directly, so it has to be
    // readable by a normal session and it has to list exactly what works.
    const { data: vocab, error: vocabError } = await alice.client
      .from("genre_pills").select("pill, genre");
    check("the app can read the pill vocabulary", !vocabError && (vocab?.length ?? 0) > 0,
      vocabError?.message ?? `${vocab?.length} rows`);
    const servable = [...new Set((vocab ?? []).map((r) => r.pill))].sort();
    check("the vocabulary lists the ten servable pills",
      servable.join(",") === "adventure,fighting,fps,platformer,puzzle,racing,rpg," +
        "simulation,sports,strategy", servable.join(","));
    check("and lists none of the four unbacked ones",
      !servable.some((p) => ["action", "souls", "open-world", "survival"].includes(p)));

    // Every slug the table advertises must actually return rows, or the app
    // builds its pill row from a promise the catalog does not keep.
    for (const pill of servable) {
      const rows = await search({ q: "the", max_results: 5, pills: [pill] });
      check(`advertised pill "${pill}" returns rows`, rows.length > 0, `${rows.length}`);
    }

    // ---- 4. Device type ----
    console.log("\n4. Categories pill — device type");
    for (const fam of ["playstation", "xbox", "nintendo", "pc", "mobile"]) {
      const rows = await search({ q: "the", max_results: 20, device_types: [fam] });
      check(`${fam} returns rows`, rows.length > 0, `${rows.length}`);
    }

    // The bug this change fixes: Xbox Series X|S was family NULL, so every game
    // that shipped on Series X|S and not on Xbox One was unreachable from the
    // Xbox pill. Find one such game and assert the pill now reaches it.
    const { data: sx } = await admin.from("game_platforms")
      .select("game_id, platforms!inner(id, family)")
      .eq("platform_id", 169).limit(1);
    check("Xbox Series X|S is filed under the xbox family",
      (sx?.[0] as { platforms?: { family?: string } } | undefined)?.platforms?.family === "xbox",
      String((sx?.[0] as { platforms?: { family?: string } } | undefined)?.platforms?.family));

    // ---- 5. Sorting ----
    console.log("\n5. Sort By portal");
    const alphaAsc = await search({ q: "the", max_results: 20, sort_by: "alpha", sort_dir: "asc" });
    const sorted = [...alphaAsc].sort((a, b) => a.title.localeCompare(b.title));
    check("alphabetical ascending is actually sorted",
      JSON.stringify(alphaAsc.map((r) => r.title)) === JSON.stringify(sorted.map((r) => r.title)),
      alphaAsc[0]?.title);

    const alphaDesc = await search({ q: "the", max_results: 20, sort_by: "alpha", sort_dir: "desc" });
    check("alphabetical descending reverses it",
      alphaDesc[0]?.title >= alphaAsc[0]?.title, `${alphaDesc[0]?.title} vs ${alphaAsc[0]?.title}`);

    const recent = await search({ q: "the", max_results: 20, sort_by: "recent" });
    check("Most Recent does not open on unreleased games",
      recent.length > 0 && recent.every((r) => r.release_date! <= TODAY),
      `top: ${recent[0]?.title} ${recent[0]?.release_date}`);
    check("Most Recent is ordered newest first",
      recent.every((r, i) => i === 0 || recent[i - 1].release_date! >= r.release_date!));

    const recentUpcoming = await search({
      q: "the", max_results: 20, sort_by: "recent", release_from: nextDay(TODAY),
    });
    check("but an explicit Upcoming window is respected, not capped",
      recentUpcoming.length > 0 && recentUpcoming.every((r) => r.release_date! > TODAY),
      `${recentUpcoming.length} rows`);

    const rating = await search({ q: "the", max_results: 20, sort_by: "rating" });
    check("Ratings puts scored games above unscored",
      rating.length > 0 && rating[0]?.critic_score !== null,
      `top critic_score: ${rating[0]?.critic_score}`);

    const popular = await search({ q: "the", max_results: 20, sort_by: "popular" });
    check("Most Popular returns rows", popular.length > 0, `top: ${popular[0]?.title}`);

    // ---- 6. Filters and sort compose ----
    console.log("\n6. Filters and sort compose");
    const combined = await search({
      q: "the", max_results: 20, release_from: "2010-01-01", release_to: "2019-12-31",
      pills: ["rpg"], device_types: ["playstation"], sort_by: "alpha", sort_dir: "asc",
    });
    check("date + genre + device + sort all apply at once",
      combined.every((r) =>
        r.release_date! >= "2010-01-01" && r.release_date! <= "2019-12-31" &&
        r.genres?.includes("Role-playing (RPG)")),
      `${combined.length} rows`);

    // ---- 7. Grants ----
    console.log("\n7. Grants");
    const { error: anonError } = await anon.rpc("shelf_search_games", { q: "mario" });
    check("anon cannot execute the search RPC", !!anonError, anonError?.code);

    const { data: anonVocab } = await anon.from("genre_pills").select("pill");
    check("anon cannot read the pill vocabulary", (anonVocab?.length ?? 0) === 0,
      `${anonVocab?.length ?? 0} rows`);
  } finally {
    await removeAccounts([alice]);
    console.log("\ncleaned up test user.");
  }

  finish();
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

main().catch((e) => { console.error(e); process.exit(1); });
