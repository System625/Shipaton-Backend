// POST /xbox-link-start -> { redirectUrl, nonce }
//
// Step 1 of three, same shape as steam-link-start: the app opens `redirectUrl`,
// the user signs in with Microsoft, xbl.io redirects to /xbox-link-callback, the
// app comes back and calls /xbox-link-finish with `nonce`.
//
// UNVERIFIED — see _shared/xbox.ts, "UNVERIFIED #1". The nonce is appended to the
// auth URL as `?state=`, a bet that xbl.io echoes it back on the callback rather
// than dropping it. If it does not, the callback has nothing to correlate against
// and fails closed rather than guessing — see xbox-link-callback. Needs a human to
// complete the real flow once before this is trusted, the same way Sola's 14 Sep
// run confirmed Steam's.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { xboxDelegatedAuthUrl } from "../_shared/xbox.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const { error } = await auth.supabase
    .from("platform_link_nonces")
    .insert({ nonce, user_id: auth.userId, platform: "xbox" });
  if (error) return errorResponse(error.message, 500);

  const redirectUrl = xboxDelegatedAuthUrl(Deno.env.get("OPENXBL_API_KEY")!, nonce);
  return json({ redirectUrl, nonce });
});
