// POST /share/confirm {intakeId, gameId} -> LibraryEntry
//
// The user has tapped a game on the confirm screen. This is the only path that
// writes a shared game into a library, and source_url comes with it — that field
// is the differentiator, and what later makes the finish card interesting:
// "found on TikTok in March, beaten in September" beats a bare rating.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  let intakeId: string, gameId: string;
  try {
    ({ intakeId, gameId } = await req.json());
  } catch {
    return errorResponse("expected JSON body {intakeId, gameId}", 400);
  }
  if (!intakeId || !gameId) return errorResponse("intakeId and gameId are required", 400);

  // RLS already scopes this to the caller; the filter makes the 404 explicit.
  const { data: intake, error: intakeError } = await auth.supabase
    .from("share_intake")
    .select("id, raw_url, provider")
    .eq("id", intakeId)
    .maybeSingle();
  if (intakeError) return errorResponse(intakeError.message, 500);
  if (!intake) return errorResponse("intake not found", 404);

  const sourceKind =
    intake.provider === "tiktok" || intake.provider === "youtube" ? intake.provider : "manual";

  const { data: entry, error: entryError } = await auth.supabase
    .from("library_entries")
    .upsert(
      {
        user_id: auth.userId,
        game_id: gameId,
        status: "backlog",
        source_url: intake.raw_url,
        source_kind: sourceKind,
      },
      { onConflict: "user_id,game_id", ignoreDuplicates: false },
    )
    .select("*")
    .single();
  if (entryError) return errorResponse(entryError.message, 500);

  await auth.supabase
    .from("share_intake")
    .update({ status: "matched", matched_game_id: gameId })
    .eq("id", intakeId);

  return json(entry);
});
