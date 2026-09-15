// POST /xbox-link-finish {nonce} -> PlatformAccount
//
// Step 3 of three, identical shape to steam-link-finish: the write happens under
// the caller's own JWT, so RLS — not this code — guarantees the connection lands
// on the right account. All the nonce lookup can do is fail.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { fetchXboxAccount } from "../_shared/xbox.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  let nonce: string;
  try {
    ({ nonce } = await req.json());
  } catch {
    return errorResponse("expected JSON body {nonce}", 400);
  }
  if (!nonce) return errorResponse("nonce is required", 400);

  const { data: row, error } = await auth.supabase
    .from("platform_link_nonces")
    .select("nonce, platform, verified_external_id, expires_at, consumed_at")
    .eq("nonce", nonce)
    .maybeSingle();
  if (error) return errorResponse(error.message, 500);
  if (!row) return errorResponse("link request not found", 404);
  if (row.consumed_at) return errorResponse("link request already used", 409);
  if (!row.verified_external_id) return errorResponse("xbox did not confirm this sign-in", 409);
  if (new Date(row.expires_at) < new Date()) return errorResponse("link request expired", 410);

  // Cosmetic only, and deliberately not fatal — see fetchXboxAccount's own
  // UNVERIFIED note in _shared/xbox.ts. A missing gamertag/avatar is not a reason
  // to refuse a connection xbl.io has already verified.
  const account = await fetchXboxAccount(
    Deno.env.get("OPENXBL_API_KEY")!,
    row.verified_external_id,
  ).catch(() => null);

  const { data: platformAccount, error: accountError } = await auth.supabase
    .from("platform_accounts")
    .upsert({
      user_id: auth.userId,
      platform: "xbox",
      external_id: row.verified_external_id,
      display_name: account?.gamertag ?? null,
      avatar_url: account?.avatar ?? null,
      linked_at: new Date().toISOString(),
    }, { onConflict: "user_id,platform" })
    .select("*")
    .single();

  if (accountError) {
    if (accountError.code === "23505") {
      return errorResponse("that xbox account is already linked to another shelf account", 409);
    }
    return errorResponse(accountError.message, 500);
  }

  await auth.supabase
    .from("platform_link_nonces")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce);

  return json(platformAccount);
});
