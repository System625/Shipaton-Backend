// GET /steam-link-callback?nonce=...&openid.* -> 302 back into the app
//
// Step 2 of three, and the only endpoint in this backend that is not
// authenticated. Steam's servers send the user's browser here after sign-in, so
// there is no Authorization header to read and there cannot be one. Deploy with
// --no-verify-jwt; the config.toml entry says the same thing for local serve.
//
// TWO THINGS MAKE THIS SAFE, and both are load-bearing:
//
//   1. Every openid.* parameter is attacker-controlled until Steam confirms the
//      signature. verifySteamOpenId() does the check_authentication round trip and
//      returns null on anything else. Reading the SteamID straight out of
//      `openid.claimed_id` would be account takeover by impersonation.
//   2. The nonce, not the request, says who this is for. It was minted by an
//      authenticated /steam-link-start call, it is single-use, and it expires in
//      ten minutes.
//
// It uses the service role — the only place in this backend that does — because a
// request with no JWT still has to record the result against a nonce row that RLS
// would otherwise hide. It writes exactly two columns, on exactly one row, and
// creates no connection: the actual link is written by /steam-link-finish under
// the user's own JWT.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, errorResponse } from "../_shared/http.ts";
import { verifySteamOpenId } from "../_shared/steam.ts";

/** Where to drop the user after Steam is done. The app owns this scheme. */
const appReturn = (status: string, nonce: string) => {
  const base = Deno.env.get("APP_LINK_RETURN_URL") ?? "shelf://link/steam";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}status=${encodeURIComponent(status)}&nonce=${encodeURIComponent(nonce)}`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const url = new URL(req.url);
  const nonce = url.searchParams.get("nonce");
  if (!nonce) return errorResponse("missing nonce", 400);

  const steamId64 = await verifySteamOpenId(url.searchParams);
  if (!steamId64) {
    return Response.redirect(appReturn("failed", nonce), 302);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Narrowed hard: an unexpired, unconsumed, not-yet-verified Steam nonce. Replaying
  // a callback URL therefore does nothing on the second click, and a nonce minted
  // for a different platform cannot be redirected through this handler.
  const { data, error } = await admin
    .from("platform_link_nonces")
    .update({ verified_external_id: steamId64, verified_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .eq("platform", "steam")
    .is("consumed_at", null)
    .is("verified_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("nonce")
    .maybeSingle();

  if (error || !data) return Response.redirect(appReturn("expired", nonce), 302);
  return Response.redirect(appReturn("ok", nonce), 302);
});
