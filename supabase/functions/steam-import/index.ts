// POST /steam-import -> ImportResult
//
// The payoff. One Steam call, one resolve, one write, no IGDB round trips at all.
//
// WHAT THE RESPONSE IS FOR. `total` and `matched` differ, always — roughly 12% of a
// real library does not reach our catalog (section 1), and some of that 12% is
// correct behaviour rather than failure: Blender, Wallpaper Engine and Source
// Filmmaker are in people's Steam libraries and are not games. The app should show
// both numbers; "done" invites the user to go looking for what is missing.
//
// BUT `total` IS NOT "YOUR STEAM LIBRARY" AND MUST NOT BE LABELLED AS IF IT WERE.
// This comment used to call "We added 412 of your 468 Steam games" honest and fine.
// It is not, and the first outside tester found that on 14 Sep 2026: he saw 11
// games in Steam, the API handed us 5, and the app told him 4 of 5 — a library size
// he could see was wrong. Steam does not return a free-to-play game the user has
// never launched, because the account does not own it until first run, and no
// parameter brings it back (see fetchOwnedGames). `total` is what Steam disclosed,
// nothing more. Say "Added N games from Steam" and keep the unmatched count behind
// a details tap — section 3a.
//
// AND THE PAYWALL GOES AFTER THIS RESPONSE, NOT BEFORE IT (decided 14 Sep,
// docs/research/pricing.md section 4). Imported rows count against
// FREE_TIER_GAME_LIMIT, which this endpoint does not enforce and should not: the
// user sees what we found first, then gets asked. That ordering is app-side, and
// this comment exists so nobody "fixes" it by adding a cap here.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { fetchOwnedGames, SteamProfilePrivateError } from "../_shared/steam.ts";
import { importToLibrary, minutesToHoursClamped } from "../_shared/platform-import.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { data: account, error: accountError } = await auth.supabase
    .from("platform_accounts")
    .select("external_id")
    .eq("platform", "steam")
    .maybeSingle();
  if (accountError) return errorResponse(accountError.message, 500);
  if (!account) return errorResponse("no steam account linked", 409);

  let owned;
  try {
    owned = await fetchOwnedGames(Deno.env.get("STEAM_WEB_API_KEY")!, account.external_id);
  } catch (e) {
    // The privacy case is the predicted top support complaint and it is SILENT on
    // Steam's side — a private profile is an HTTP 200 with an empty body object, not
    // an error. A generic "import failed" here would send the user hunting for a
    // problem on our side. Give them the setting and the deep link instead; the app
    // renders this as a button.
    if (e instanceof SteamProfilePrivateError) {
      return json({
        error: "steam_profile_private",
        message:
          "Your Steam game details are private, so Steam returns an empty library. " +
          "Set Game details to Public and try again.",
        fixUrl: "https://steamcommunity.com/my/edit/settings",
      }, 409);
    }
    return errorResponse(e instanceof Error ? e.message : "steam request failed", 502);
  }

  const result = await importToLibrary(
    auth.supabase,
    "steam",
    owned.map((g) => ({
      uid: String(g.appid),
      hours: minutesToHoursClamped(g.playtime_forever),
    })),
  );

  await auth.supabase
    .from("platform_accounts")
    .update({
      last_import_at: new Date().toISOString(),
      last_import_total: result.total,
      last_import_matched: result.matched,
    })
    .eq("platform", "steam");

  return json(result);
});
