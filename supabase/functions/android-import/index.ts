// POST /android-import {packages: string[]} -> ImportResult
//
// No handshake, no linked account, no external API call — Android detection
// happens entirely on-device (the `<queries>` manifest trick from Josh's thread:
// the app asks the OS which of a known list of package names are installed) and
// the app posts the hits here directly, under the caller's own JWT. That is the
// whole reason this function has a request body when steam-import and
// xbox-import do not: there is no platform_accounts row to look an account up
// from, because there is no account. See account-linking.md §7 and the migration
// header on 20260915180000_android_import.sql.
//
// HOURS ARE ALWAYS 0. Package detection tells us a game is installed, not how
// long it has been played, and there is no API to ask. Same rule as xbox-import:
// the app must not display hours for android-sourced rows.
//
// The package list itself must be a curated, catalog-backed set the app ships in
// its manifest (§7: "a curated top-500 list is a requirement, not a shortcut") —
// see scripts/generate-android-manifest.ts, which prints exactly that set from
// game_external_ids so the app's list and our catalog cannot disagree.

import { authenticate, errorResponse, json, corsHeaders } from "../_shared/http.ts";
import { importToLibrary } from "../_shared/platform-import.ts";

// The curated manifest tops out at a few hundred entries (§7's "top-500"); this
// is a generous multiple of that, not a real limit — it exists only so a
// malformed or hostile body cannot make one call resolve an unbounded array.
const MAX_PACKAGES = 3000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("method not allowed", 405);

  const auth = await authenticate(req);
  if (auth instanceof Response) return auth;

  let packages: unknown;
  try {
    ({ packages } = await req.json());
  } catch {
    return errorResponse("expected JSON body {packages: string[]}", 400);
  }
  if (!Array.isArray(packages) || packages.some((p) => typeof p !== "string" || p.length === 0)) {
    return errorResponse("packages must be a non-empty array of package name strings", 400);
  }
  if (packages.length > MAX_PACKAGES) {
    return errorResponse(`packages exceeds ${MAX_PACKAGES}`, 400);
  }

  // Dedupe here rather than relying on shelf_import_library's group-by alone —
  // the same package name appearing twice in one body is a client bug worth not
  // paying an extra resolve row for, not a reason to fail the request.
  const uniquePackages = [...new Set(packages as string[])];

  const result = await importToLibrary(
    auth.supabase,
    "android",
    uniquePackages.map((uid) => ({ uid, hours: 0 })),
  );
  return json(result);
});
