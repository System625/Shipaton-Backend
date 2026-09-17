// POST /game-release-sweep -> { swept: number }
//
// The write side of the Release-Day Tracker (Session B, docs/research/events-
// screen.md §4): finds every game whose announced release day is today and rings
// the bell for everyone watching it. Fired on a schedule, same reasoning as
// push-sweep -- nothing in a game row's lifecycle fires an INSERT the way a follow
// does, so this has to be driven by time rather than a trigger. The pg_cron
// schedule that calls it is deliberately NOT in a migration, for the same reason
// push-sweep's isn't: wiring it up puts the project's service role key into
// Postgres (via Vault, for pg_net to read), and a migration file is a file
// committed to git. See docs/research/push-notifications.md for the by-hand SQL
// pattern; this wants the same treatment once someone runs it.
//
// WHO MAY CALL THIS. Same posture as push-sweep: not user-facing, checked against
// the service role key as the bearer token rather than a user session, because
// letting anyone trigger it would let anyone force a bell for every watcher of
// every game releasing today, repeatedly.
//
// This only writes the notifications row (shelf_sweep_game_releases handles
// dedupe and the release_precision = 'day' guard). Actually sending a push for
// those rows is push-sweep's job on its own next run, not this one's -- same
// separation as every other notification kind.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { errorResponse, json, corsHeaders } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (req.headers.get("Authorization") !== `Bearer ${serviceKey}`) {
    return errorResponse("this endpoint is for the scheduled sweep only", 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    serviceKey,
  );

  const { data, error } = await admin.rpc("shelf_sweep_game_releases");
  if (error) return errorResponse(error.message, 500);

  return json({ swept: Number(data) });
});
