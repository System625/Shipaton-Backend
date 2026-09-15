// GET /xbox-link-callback?state=...&code=... -> 302 back into the app
//
// Step 2 of three, and — like steam-link-callback — the one endpoint in this pair
// with no Authorization header, because xbl.io's redirect can't carry one. Deploy
// with --no-verify-jwt.
//
// THE SECURITY BOUNDARY: `code` is only worth anything after claimXboxCode()
// round-trips it to xbl.io with our app key. A forged code fails that call and
// this redirects "failed" — nobody can claim an xuid they never actually signed
// in as, the same shape of guarantee Steam's check_authentication gives.
//
// WHAT IS NOT YET PROVEN: whether `state` (the nonce from xbox-link-start) comes
// back at all — see _shared/xbox.ts UNVERIFIED #1. This fails closed on that,
// deliberately: no state param means no correlation, and the honest response is
// an error explaining why, not a guess at which user this is for.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, errorResponse } from "../_shared/http.ts";
import { claimXboxCode } from "../_shared/xbox.ts";

const appReturn = (status: string, nonce: string) => {
  const base = Deno.env.get("APP_LINK_RETURN_URL_XBOX") ?? "shelf://link/xbox";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}status=${encodeURIComponent(status)}&nonce=${encodeURIComponent(nonce)}`;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return errorResponse("method not allowed", 405);

  const url = new URL(req.url);
  const nonce = url.searchParams.get("state");
  const code = url.searchParams.get("code");

  if (!nonce) {
    return errorResponse(
      "no state param on this callback -- xbl.io may not echo it through; " +
      "see _shared/xbox.ts UNVERIFIED #1 before retrying",
      400,
    );
  }
  if (!code) return Response.redirect(appReturn("failed", nonce), 302);

  const claim = await claimXboxCode(Deno.env.get("OPENXBL_API_KEY")!, code);
  if (!claim) return Response.redirect(appReturn("failed", nonce), 302);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // Same narrowing as Steam's callback: unexpired, unconsumed, not-yet-verified,
  // and scoped to this platform so a nonce minted for Steam cannot be redirected
  // through here.
  const { data, error } = await admin
    .from("platform_link_nonces")
    .update({ verified_external_id: claim.xuid, verified_at: new Date().toISOString() })
    .eq("nonce", nonce)
    .eq("platform", "xbox")
    .is("consumed_at", null)
    .is("verified_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("nonce")
    .maybeSingle();

  if (error || !data) return Response.redirect(appReturn("expired", nonce), 302);
  return Response.redirect(appReturn("ok", nonce), 302);
});
