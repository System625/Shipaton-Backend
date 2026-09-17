// Hand-authors a season's challenges. This IS the authoring mechanism -- decision
// 17 Sep 2026 (research/events-screen.md §2) was team-authored, no creation UI, no
// admin endpoint. Adding a challenge means adding a row here and re-running this.
//
//   npx tsx scripts/seed-challenges.ts
//
// Idempotent: seasonal_challenges has a (title, start_date) unique constraint, so
// re-running with the same rows changes nothing.
//
// A NOTE ON GENRES VS THEMES. Sola's other worked example, "October Horror
// Challenge", is not representable with this criteria shape as written: IGDB
// classifies "Horror" as a theme (games.themes), not a genre (games.genres), and
// shelf_challenges() only matches on genres. Season one below sticks to the
// example that IS a genre. Widening criteria to match themes too is a real next
// step, not done here to avoid guessing at a shape nothing has asked for yet.

import { admin } from "./supabase-admin.ts";

const challenges = [
  {
    title: "Beat 3 RPGs This Month",
    description:
      "Finish three Role-playing games between 1 and 31 October to complete this challenge.",
    start_date: "2026-10-01",
    end_date: "2026-10-31",
    criteria: { genres: ["Role-playing (RPG)"], count: 3 },
  },
];

const { data, error } = await admin
  .from("seasonal_challenges")
  .upsert(challenges, { onConflict: "title,start_date" })
  .select("id, title, start_date, end_date");
if (error) throw new Error(`seasonal_challenges upsert failed: ${error.message}`);

console.log(`${data?.length ?? 0} challenge(s) written:`);
for (const c of data ?? []) console.log(`  ${c.title}  (${c.start_date} – ${c.end_date})`);
