// POST /xbox-import -> XboxImportResult
//
// Same shape as steam-import: one call to OpenXBL, one resolve+write. Unlike
// Steam's resolve, Xbox's is two-stage — see importXboxLibrary in
// _shared/platform-import.ts.
//
// IMPORT-ONLY, DELIBERATELY. docs/research/account-linking.md §4: OpenXBL's free
// tier is 150 requests/hour, APP-WIDE (one shared key, not per user), which is why
// achievement sync is out of scope — a single user's sync could burn the whole
// app's hourly budget. This endpoint costs exactly one OpenXBL call
// (titleHistory) per import, the same shape as Steam's GetOwnedGames.
//
// HOURS ARE NOT IN THE RESPONSE. See importXboxLibrary's own comment: OpenXBL's
// playtime data needs a separate, unverified call this session did not build.
// The app must not show hours for xbox-sourced rows yet.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { fetchXboxTitleHistory } from "../_shared/xbox.ts";
import { importXboxLibrary } from "../_shared/platform-import.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  const { data: account, error: accountError } = await auth.supabase
    .from("platform_accounts")
    .select("external_id")
    .eq("platform", "xbox")
    .maybeSingle();
  if (accountError) return errorResponse(accountError.message, 500);
  if (!account) return errorResponse("no xbox account linked", 409);

  let titles;
  try {
    titles = await fetchXboxTitleHistory(Deno.env.get("OPENXBL_API_KEY")!, account.external_id);
  } catch (e) {
    return errorResponse(e instanceof Error ? e.message : "xbox titleHistory failed", 502);
  }

  const result = await importXboxLibrary(auth.supabase, titles);
  return json(result);
});
