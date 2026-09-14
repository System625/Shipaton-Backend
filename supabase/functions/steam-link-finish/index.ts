// POST /steam-link-finish {nonce} -> PlatformAccount
//
// Step 3 of three. The app is back in the foreground with the nonce it started
// with; this turns a verified nonce into the connection itself.
//
// The write happens under the caller's own JWT, which is why RLS — not this code —
// is what guarantees the connection lands on the right account. All the nonce
// lookup can do is fail: a nonce belonging to somebody else is simply not visible.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { fetchPlayerSummary } from "../_shared/steam.ts";

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
  if (!row.verified_external_id) return errorResponse("steam did not confirm this sign-in", 409);
  if (new Date(row.expires_at) < new Date()) return errorResponse("link request expired", 410);

  // Cosmetic only, and deliberately not fatal: a missing avatar is not a reason to
  // refuse a connection Steam has already verified.
  const summary = await fetchPlayerSummary(
    Deno.env.get("STEAM_WEB_API_KEY")!,
    row.verified_external_id,
  ).catch(() => null);

  const { data: account, error: accountError } = await auth.supabase
    .from("platform_accounts")
    .upsert({
      user_id: auth.userId,
      platform: "steam",
      external_id: row.verified_external_id,
      display_name: summary?.personaname ?? null,
      avatar_url: summary?.avatarfull ?? null,
      linked_at: new Date().toISOString(),
    }, { onConflict: "user_id,platform" })
    .select("*")
    .single();

  if (accountError) {
    // 23505 on platform_accounts_external: this Steam account is already connected
    // to a different Shelf account. Saying so plainly beats a 500 the user cannot
    // act on.
    if (accountError.code === "23505") {
      return errorResponse("that steam account is already linked to another shelf account", 409);
    }
    return errorResponse(accountError.message, 500);
  }

  // Single-use, enforced after the fact rather than before: consuming it first would
  // lose the connection if the upsert failed.
  await auth.supabase
    .from("platform_link_nonces")
    .update({ consumed_at: new Date().toISOString() })
    .eq("nonce", nonce);

  return json(account);
});
