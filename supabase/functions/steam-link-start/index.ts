// POST /steam-link-start -> { redirectUrl, nonce }
//
// Step 1 of three. The app opens `redirectUrl` in a browser; the user signs in on
// Steam's own page; Steam redirects to /steam-link-callback; the app comes back and
// calls /steam-link-finish with `nonce`.
//
// THIS IS A CONNECTION, NOT A SIGN-IN. The request is authenticated, so a Shelf
// account already exists before any of this happens. That is what keeps App Store
// guideline 4.8 out of scope — see the comment on platform_accounts.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { steamOpenIdRedirect } from "../_shared/steam.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  // 32 bytes of CSPRNG, base64url. The nonce is the only thing binding the callback
  // to this user, so it has to be unguessable rather than merely unique.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  // Written under the caller's own JWT, so RLS stamps it to them. Nothing here
  // trusts a user_id supplied by the client.
  const { error } = await auth.supabase
    .from("platform_link_nonces")
    .insert({ nonce, user_id: auth.userId, platform: "steam" });
  if (error) return errorResponse(error.message, 500);

  // realm must be a prefix of return_to or Steam rejects the request outright.
  const functionsBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const realm = new URL(functionsBase).origin;
  const returnTo = `${functionsBase}/steam-link-callback?nonce=${encodeURIComponent(nonce)}`;

  return json({ redirectUrl: steamOpenIdRedirect(returnTo, realm), nonce });
});
