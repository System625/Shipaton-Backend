// POST /share-confirm {intakeId, gameId} -> LibraryEntry
//
// The path is share-confirm, matching the function directory. It is NOT /share/confirm;
// the gateway routes on the directory name and there is no nested path.
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

  // Insert rather than upsert. An upsert on (user_id, game_id) rewrites every column
  // it is given, so re-sharing a game the user has already BEATEN would reset its
  // status to 'backlog' and overwrite the original source_url — silently undoing
  // their progress and destroying the very provenance this endpoint exists to keep.
  // A second confirm is still idempotent: it returns the row that is already there.
  let { data: entry, error: entryError } = await auth.supabase
    .from("library_entries")
    .insert({
      user_id: auth.userId,
      game_id: gameId,
      status: "backlog",
      source_url: intake.raw_url,
      source_kind: sourceKind,
    })
    .select("*")
    .maybeSingle();

  if (entryError) {
    // 23505 = unique_violation on (user_id, game_id): they already have this game.
    if (entryError.code !== "23505") return errorResponse(entryError.message, 500);

    const existing = await auth.supabase
      .from("library_entries")
      .select("*")
      .eq("user_id", auth.userId)
      .eq("game_id", gameId)
      .single();
    if (existing.error) return errorResponse(existing.error.message, 500);
    entry = existing.data;

    // Only fill provenance in, never over. A game added by hand and later shared
    // gains the link it came from; one already carrying a source keeps its first.
    if (!entry.source_url) {
      const patched = await auth.supabase
        .from("library_entries")
        .update({ source_url: intake.raw_url, source_kind: sourceKind })
        .eq("id", entry.id)
        .select("*")
        .single();
      if (!patched.error) entry = patched.data;
    }
  }

  await auth.supabase
    .from("share_intake")
    .update({ status: "matched", matched_game_id: gameId })
    .eq("id", intakeId);

  return json(entry);
});
