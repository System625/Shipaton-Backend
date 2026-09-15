// OpenXBL (xbl.io) client: delegated auth + title history.
//
// UNVERIFIED IN TWO PLACES, MARKED BELOW, AND BOTH NEED A HUMAN BEFORE THIS IS
// TRUSTED — the same status Steam's OpenID handshake had until Sola drove it for
// real on 14 Sep. Do not read a deploy of this file as "Xbox linking works."
//
// What IS grounded, not guessed: the delegated-auth mechanics below (claim(),
// the app-key-plus-X-Contract-header model for calling another user's data) come
// from OpenXBL's own published source — `OpenXBL/OpenXBL-PHP` (Auth.php,
// Client.php, HttpService.php) and the OpenAPI spec at `OpenXBL/Docs` on GitHub,
// both pulled and read on 15 Sep 2026, not the account-linking research doc's
// paraphrase. That paraphrase was WRONG on one point, corrected here: there is no
// "per-user API key" handed back by claim() — every delegated call, own account or
// someone else's, uses our single app key (OPENXBL_API_KEY), with `X-Contract: 100`
// marking it as an app-level call and the target's `xuid` in the path.

const XBL_APP_BASE = "https://xbl.io/app";
const XBL_API_BASE = "https://xbl.io/api/v2";

/**
 * UNVERIFIED #1 — THE CORRELATION PROBLEM.
 *
 * Steam's OpenID flow carries our own nonce through `openid.return_to`, which
 * Steam echoes back verbatim; that is how /steam-link-callback knows which Shelf
 * user this is for. OpenXBL's simplified `https://xbl.io/app/auth/{key}` entry
 * point, per every source reachable on 15 Sep 2026 (the PHP wrapper's
 * `getLoginUrl()`, the OpenAPI spec, the GitHub docs repo — the interactive docs
 * site itself returned Cloudflare's bot-block from here), shows NO state or
 * correlation parameter at all. The app registers ONE fixed redirect URL in the
 * xbl.io dashboard; it is not customized per request the way Steam's `return_to`
 * is.
 *
 * RE-CHECKED 15 Sep 2026 via a real Chrome session, not just a server-side fetch,
 * on the theory that the block might be a bot-detection challenge a real browser
 * clears: it is not. `xbl.io` hard-blocks the entire domain (`/`, not only
 * `/docs`) for this network regardless of client. GitHub's `OpenXBL/Docs` and
 * `OpenXBL/OpenXBL-PHP` were re-read in full and add nothing new here — no
 * `state`/correlation param anywhere in either repo. Confirms the reasoning
 * above rather than replacing it; do not re-attempt this from a browser again
 * without a new reason to think it would differ.
 *
 * This function appends `?state=<value>` speculatively, on the bet that xbl.io's
 * redirect passes through an unrecognized query param rather than dropping it —
 * a common pattern for thin OAuth proxies, but NOT confirmed for this one. If the
 * real callback arrives with no `state`, xbox-link-callback has nothing to
 * correlate against and fails closed (see the comment there) — it does not fall
 * back to trusting the request unauthenticated. Confirm this by having someone
 * complete the real flow once and reading what actually comes back.
 */
export function xboxDelegatedAuthUrl(publicKey: string, state: string): string {
  return `${XBL_APP_BASE}/auth/${encodeURIComponent(publicKey)}?state=${encodeURIComponent(state)}`;
}

export type XboxClaim = {
  xuid: string;
  gamertag: string;
  email?: string;
  avatar?: string | null;
};

/**
 * Resolves a delegated-auth `code` to the identity that completed it. Grounded in
 * OpenXBL-PHP's Auth.php: `POST https://xbl.io/app/claim` with JSON
 * `{code, app_key}`, and the response fields (`xuid`, `gamertag`, `email`,
 * `avatar`) are read directly off `ClaimsResponse.php`, not guessed.
 */
export async function claimXboxCode(publicKey: string, code: string): Promise<XboxClaim | null> {
  const res = await fetch(`${XBL_APP_BASE}/claim`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ code, app_key: publicKey }),
  });
  if (!res.ok) return null;
  const body = await res.json() as { xuid?: string; gamertag?: string; email?: string; avatar?: string };
  if (!body.xuid || !body.gamertag) return null;
  return { xuid: body.xuid, gamertag: body.gamertag, email: body.email, avatar: body.avatar ?? null };
}

function delegatedHeaders(apiKey: string): HeadersInit {
  // x-authorization per the OpenXBL OpenAPI spec's securitySchemes (checked 15 Sep
  // 2026, not assumed). X-Contract: 100 marks this as an APP call -- the app's own
  // key acting on a consenting user's behalf, per HttpService.php's `isApp` flag --
  // as opposed to a personal key reading its own owner's data.
  return { "X-Authorization": apiKey, "X-Contract": "100", Accept: "application/json" };
}

export type XboxAccount = { gamertag?: string; avatar?: string };

/** Display name and avatar for the connection screen. Mirrors fetchPlayerSummary. */
export async function fetchXboxAccount(apiKey: string, xuid: string): Promise<XboxAccount | null> {
  const res = await fetch(`${XBL_API_BASE}/account/${encodeURIComponent(xuid)}`, {
    headers: delegatedHeaders(apiKey),
  });
  if (!res.ok) return null;
  // This part of #2 is NOW VERIFIED, 15 Sep 2026: OpenXBL/Docs' account.json
  // carries a real worked example for this exact endpoint --
  // `profileUsers[].settings[]` as `{id, value}` pairs -- matching what this
  // function already assumed, field for field. titleHistory is the part of #2
  // that remains unverified; see fetchXboxTitleHistory below.
  const body = await res.json() as {
    profileUsers?: { settings?: { id: string; value: string }[] }[];
  };
  const settings = body.profileUsers?.[0]?.settings ?? [];
  const byId = (id: string) => settings.find((s) => s.id === id)?.value;
  return { gamertag: byId("Gamertag"), avatar: byId("GameDisplayPicRaw") };
}

export type XboxTitle = { titleId: string; name: string };

/**
 * UNVERIFIED #2 — THE RESPONSE SHAPE.
 *
 * Neither OpenXBL's OpenAPI spec nor any source I could reach on 15 Sep 2026
 * documents titleHistory's actual response fields (the spec lists the endpoint
 * and its `{xuid}` path param, `responses: 200: description: Success`, nothing
 * else). What is used below — a `titles` array of `{titleId, name}` — is
 * Microsoft's own real Xbox Live titlehub shape, which OpenXBL is known to proxy
 * closely for most endpoints; it is NOT confirmed for this specific one.
 *
 * Fails loudly rather than silently: if fewer than half the returned entries carry
 * both fields, this throws instead of quietly importing a fraction of a library
 * and reporting success. That is the number a live test against a real account
 * would immediately expose either way.
 */
export async function fetchXboxTitleHistory(apiKey: string, xuid: string): Promise<XboxTitle[]> {
  const res = await fetch(`${XBL_API_BASE}/player/titleHistory/${encodeURIComponent(xuid)}`, {
    headers: delegatedHeaders(apiKey),
  });
  if (!res.ok) throw new Error(`xbox titleHistory failed: ${res.status}`);

  const body = await res.json() as { titles?: { titleId?: string; name?: string }[] };
  const raw = body.titles ?? [];
  const titles = raw.flatMap((t) => (t.titleId && t.name ? [{ titleId: t.titleId, name: t.name }] : []));

  if (raw.length > 0 && titles.length < raw.length / 2) {
    throw new Error(
      `xbox titleHistory: only ${titles.length}/${raw.length} entries carried titleId+name — ` +
      `the response shape is probably not what this file assumes; verify against a live account`,
    );
  }
  return titles;
}
