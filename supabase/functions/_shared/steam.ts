// Steam Web API + OpenID 2.0 client.
//
// Every shape in this file was checked against the live service on 14 Sep 2026,
// not read off a wiki. Where the research memo and the live API disagree, the API
// wins and the disagreement is written down — see GetOwnedGames below.
//
// Runtime-agnostic, same rule as igdb.ts: no Deno or Node globals, so the import
// path and the measurement scripts share one implementation.

// Confirmed live: https://steamcommunity.com/openid/ serves an XRDS document whose
// only Service URI is this. Hardcoded rather than discovered per request, because
// discovery adds a round trip to every sign-in for a value that has not moved.
const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

const OPENID_NS = "http://specs.openid.net/auth/2.0";
const OPENID_IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";

/**
 * The URL to send the user to. They sign in on Steam's own page; we never see a
 * Steam password, which is rule 1 of section 9.
 *
 * `realm` must be a prefix of `returnTo` or Steam rejects the request. Valve also
 * requires one of their supplied "Sign in through Steam" button images on the
 * button that leads here — an app-side obligation, noted so it is not discovered
 * during store review.
 */
export function steamOpenIdRedirect(returnTo: string, realm: string): string {
  const params = new URLSearchParams({
    "openid.ns": OPENID_NS,
    "openid.mode": "checkid_setup",
    "openid.return_to": returnTo,
    "openid.realm": realm,
    // identifier_select means "you tell us who signed in". We are not claiming to
    // already know the SteamID; that is the entire point of the round trip.
    "openid.identity": OPENID_IDENTIFIER_SELECT,
    "openid.claimed_id": OPENID_IDENTIFIER_SELECT,
  });
  return `${STEAM_OPENID_ENDPOINT}?${params}`;
}

const CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

/**
 * Verify an OpenID callback and return the SteamID64, or null.
 *
 * THIS IS THE SECURITY BOUNDARY OF THE WHOLE FEATURE. The parameters arrive on a
 * redirect the *user's browser* performed, so every one of them is attacker
 * controlled until Steam confirms the signature. A callback handler that reads the
 * SteamID out of `openid.claimed_id` and believes it is an account-takeover bug:
 * anyone could bind any Steam library to their own Shelf account, or bind their own
 * to somebody else's. The `check_authentication` round trip below is what makes the
 * claim true, and it must happen server-side.
 *
 * Every openid.* parameter received has to go back verbatim with only `mode`
 * changed — the signature covers the fields named in `openid.signed`, and dropping
 * or rewriting any of them invalidates it.
 */
export async function verifySteamOpenId(params: URLSearchParams): Promise<string | null> {
  const claimedId = params.get("openid.claimed_id");
  if (!claimedId) return null;

  // Check the shape before spending a network call, and — more importantly —
  // before trusting the string later. A SteamID64 is exactly 17 digits.
  const match = CLAIMED_ID_PATTERN.exec(claimedId);
  if (!match) return null;

  const body = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.startsWith("openid.")) body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  const res = await fetch(STEAM_OPENID_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) return null;

  // Key-value form, not JSON: "ns:http://...\nis_valid:true\n".
  const text = await res.text();
  const valid = text.split("\n").some((line) => line.trim() === "is_valid:true");
  return valid ? match[1] : null;
}

// ---- Web API ----

const STEAM_API = "https://api.steampowered.com";

export type SteamOwnedGame = {
  appid: number;
  name?: string;
  /** MINUTES, not hours. */
  playtime_forever?: number;
};

export class SteamProfilePrivateError extends Error {
  constructor() {
    super("steam profile is private");
    this.name = "SteamProfilePrivateError";
  }
}

/**
 * The whole library in one call. A 4,652-game account returns in a single
 * response, so an import is one request per user and the 100,000 calls/day ceiling
 * in Valve's terms is not a constraint worth engineering around.
 *
 * WHAT THE LIVE API ACTUALLY RETURNS, measured 14 Sep 2026 against a real public
 * 4,652-game library (SteamID 76561198023414915):
 *
 *     appid, name, playtime_forever, img_icon_url, content_descriptorids,
 *     has_community_visible_stats, has_leaderboards
 *
 * and with include_extended_appinfo=1, additionally capsule_filename, sort_as,
 * has_dlc, has_market, has_workshop.
 *
 * **`docs/research/account-linking.md` section 3 is wrong about this** and has been
 * corrected: it claimed the response also carries `playtime_windows_forever`,
 * `playtime_mac_forever`, `playtime_linux_forever`, `playtime_deck_forever` and
 * `rtime_last_played`. Across all 4,652 rows of that library, not one carried any
 * of the five. They are documented fields, but a third-party publisher key reading
 * *another* user's profile does not get them. So: no per-device split, and no
 * last-played date. Anything downstream that wants "last played" has to get it
 * somewhere else.
 *
 * PRIVACY IS THE TOP SUPPORT CASE AND IT IS SILENT. A profile whose **Game
 * details** are not Public returns HTTP 200 with `{"response":{}}` — no `games`
 * array and no `game_count` at all, which is indistinguishable from success unless
 * you look for it. (A bad key is a 403, so the two are at least distinguishable
 * from each other.) That is why this throws a typed error rather than returning an
 * empty list: an empty list would import zero games and report success.
 *
 * `skip_unvetted_apps=0` IS LOAD-BEARING, added 14 Sep 2026. It defaults to *true*
 * server-side, which silently drops apps Valve has not fully vetted. On the first
 * outside tester's account that was 2 of 7 games — both of which are in our catalog
 * and both of which he could see in his own Steam library. On the 4,652-game
 * reference library it adds 15 (+0.3%). It is not a "show me junk" switch; the
 * default is simply wrong for a library importer.
 *
 * WHAT THIS CALL STILL CANNOT SEE, and it is not a bug we can fix: a free-to-play
 * game the user has **never launched**. Steam grants the license on first run, so
 * until then the account does not own it and GetOwnedGames does not list it — with
 * or without `include_played_free_games`. The gate is OWNERSHIP, not playtime:
 * purchased games with zero hours come back fine (4,504 of the reference library's
 * 4,652 rows have `playtime_forever: 0`). The community profile XML that used to
 * expose them now 302s to a login page, so there is no third-party route to them.
 *
 * The consequence lands on the APP, not here: a user who sees 11 games in their
 * Steam library can have 7 of them reachable, and an import that reports "we added
 * N of your M" where M is this list's length is quietly telling them the wrong M.
 * Measured on tester account 76561199670893904, 14 Sep 2026.
 */
export async function fetchOwnedGames(
  apiKey: string,
  steamId64: string,
): Promise<SteamOwnedGame[]> {
  const url =
    `${STEAM_API}/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}` +
    `&steamid=${encodeURIComponent(steamId64)}` +
    `&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=0&format=json`;

  const res = await fetch(url);
  if (res.status === 403) throw new Error("steam api key rejected");
  if (!res.ok) throw new Error(`steam GetOwnedGames failed: ${res.status}`);

  const body = (await res.json()) as { response?: { game_count?: number; games?: SteamOwnedGame[] } };
  if (!body.response || body.response.game_count === undefined) {
    throw new SteamProfilePrivateError();
  }
  return body.response.games ?? [];
}

export type SteamPlayerSummary = {
  steamid: string;
  personaname?: string;
  avatarfull?: string;
  profileurl?: string;
};

/** Display name and avatar for the connection screen. One call, cheap. */
export async function fetchPlayerSummary(
  apiKey: string,
  steamId64: string,
): Promise<SteamPlayerSummary | null> {
  const url =
    `${STEAM_API}/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}` +
    `&steamids=${encodeURIComponent(steamId64)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = (await res.json()) as { response?: { players?: SteamPlayerSummary[] } };
  return body.response?.players?.[0] ?? null;
}
