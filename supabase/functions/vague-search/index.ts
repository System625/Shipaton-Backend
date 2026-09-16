// POST /vague-search   { query: string }  ->  VagueSearchJob   (202 if not answered yet)
// GET  /vague-search?job=<uuid>           ->  VagueSearchJob
//
// "The game I saw two days ago" — docs/research/semantic-search.md. Naming the
// model call directly costs a measured median 25.7s, p90 68.8s, **max 227.5s**
// (§7/§11), which is longer than an edge function is allowed to run at all (150s
// wall clock). So this endpoint never calls the model itself: it only creates and
// reads a job row. `vague-search-sweep` (scheduled separately, same shape as
// `push-sweep`) does the actual work.
//
// VagueSearchJob:
//   { id, status: 'pending'|'processing'|'done'|'error', query,
//     candidates: CatalogGame[], confidence: number|null, fromCache: boolean,
//     error: string|null, createdAt, completedAt }
//
// `confidence` is returned as the model gave it, unthresholded. Whether/where to
// show a "we're not sure" state instead of a result list is a product decision for
// Paul (§11 step 6) and is deliberately not decided here.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { catalogGamesByIds } from "../_shared/games-by-ids.ts";

const MIN_QUERY_LENGTH = 4;

type JobRow = {
  id: string;
  query: string;
  status: "pending" | "processing" | "done" | "error";
  candidates: { game_id: string; title: string; score: number | null }[];
  confidence: number | null;
  from_cache: boolean;
  error: string | null;
  created_at: string;
  completed_at: string | null;
};

async function toResponseBody(supabase: any, row: JobRow) {
  const ids = row.candidates.map((c) => c.game_id);
  const games = await catalogGamesByIds(supabase, ids);
  return {
    id: row.id,
    status: row.status,
    query: row.query,
    candidates: games,
    confidence: row.confidence,
    fromCache: row.from_cache,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  if (req.method === "GET") {
    const jobId = new URL(req.url).searchParams.get("job");
    if (!jobId) return errorResponse("expected ?job=<uuid>", 400);

    // RLS scopes this to the caller's own rows already; the explicit filter is
    // just what turns "not yours" and "does not exist" into the same 404 rather
    // than a confusing empty-body 200.
    const { data, error } = await auth.supabase
      .from("vague_search_jobs")
      .select("id, query, status, candidates, confidence, from_cache, error, created_at, completed_at")
      .eq("id", jobId)
      .maybeSingle();
    if (error) return errorResponse(error.message, 500);
    if (!data) return errorResponse("job not found", 404);

    return json(await toResponseBody(auth.supabase, data as JobRow));
  }

  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse("expected a JSON body", 400);
  }
  const rawQuery = body && typeof body === "object" ? (body as Record<string, unknown>).query : undefined;
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (query.length < MIN_QUERY_LENGTH) {
    return errorResponse(`query must be at least ${MIN_QUERY_LENGTH} characters`, 400);
  }

  // The instant path: someone else already asked (near-)this exact question in
  // the last 30 days. shelf_vague_search_cache_get bypasses search_cache's RLS
  // (it has none) and normalizes the query the same way game titles are
  // normalized, which is a fine cache key for "was this exact sentence asked
  // before" even though it was never meant for prose.
  const { data: cachedIds, error: cacheError } = await auth.supabase
    .rpc("shelf_vague_search_cache_get", { p_query: query })
    .returns<string[] | null>();
  if (cacheError) return errorResponse(cacheError.message, 500);

  if (cachedIds && cachedIds.length > 0) {
    const candidates = cachedIds.map((id) => ({ game_id: id, title: "", score: null }));
    const { data: inserted, error: insertError } = await auth.supabase
      .from("vague_search_jobs")
      .insert({
        user_id: auth.userId,
        query,
        status: "done",
        candidates,
        confidence: null,
        from_cache: true,
        completed_at: new Date().toISOString(),
      })
      .select("id, query, status, candidates, confidence, from_cache, error, created_at, completed_at")
      .single();
    if (insertError) return errorResponse(insertError.message, 500);
    return json(await toResponseBody(auth.supabase, inserted as JobRow));
  }

  // Cache miss: create the job and hand it to the sweep. Nothing here calls the
  // model — see the file comment for why.
  const { data: created, error: insertError } = await auth.supabase
    .from("vague_search_jobs")
    .insert({ user_id: auth.userId, query })
    .select("id, query, status, candidates, confidence, from_cache, error, created_at, completed_at")
    .single();
  if (insertError) return errorResponse(insertError.message, 500);

  return json(await toResponseBody(auth.supabase, created as JobRow), 202);
});
