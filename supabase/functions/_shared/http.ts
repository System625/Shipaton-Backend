// Shared edge-function plumbing: CORS, JSON responses, and per-request auth.
//
// Every endpoint is authenticated. The client is built with the caller's own JWT,
// so RLS applies to everything it touches — an edge function must never reach for
// the service role key to read user data.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

export type AuthedRequest = { supabase: SupabaseClient; userId: string };

/** Returns a Response on failure, or the authed context on success. */
export async function authenticate(req: Request): Promise<AuthedRequest | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return errorResponse("missing Authorization header", 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } },
  );

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return errorResponse("invalid or expired token", 401);

  return { supabase, userId: data.user.id };
}

export function igdbCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: Deno.env.get("TWITCH_CLIENT_ID")!,
    clientSecret: Deno.env.get("TWITCH_CLIENT_SECRET")!,
  };
}
