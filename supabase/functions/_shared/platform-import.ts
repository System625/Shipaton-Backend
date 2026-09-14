// The platform-agnostic half of an import: clamp, resolve, write, report.
//
// Steam is the only caller today. Xbox will be the second and will hand this the
// same shape — a list of {uid, hours} — which is the reason it is a separate file
// rather than living inside steam-import.

// Structurally typed rather than importing SupabaseClient from jsr:, for the same
// reason igdb.ts has no imports at all: this file is also read by the Node
// verification script, and a Deno-only specifier would break `npm run typecheck`.
// Both clients satisfy this shape.
type RpcClient = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

/**
 * `library_entries.hours_played` is numeric(5,1): five digits, so 9,999.9 is the
 * ceiling and 10,000.0 raises `numeric field value out of range`. Postgres fails
 * the whole statement, not the row, so ONE long-time player takes their entire
 * import with them — the same shape as the bad time-to-beat row that killed the
 * first catalog seed.
 *
 * This is not hypothetical and the margin is thin: the real 4,652-game library used
 * to verify this feature on 14 Sep 2026 has **9,120.6 hours** on Counter-Strike 2.
 * That account is 880 hours from breaking an unclamped import.
 *
 * CLAMP, DO NOT WIDEN THE COLUMN (section 8a). A clamped 9,999.9 is honest enough
 * — nobody reads their own playtime as a precise figure at that scale — and a
 * failed import is not honest at all. Contrast secondsToHours() in mapping.ts,
 * which NULLS an over-range time-to-beat instead: that value was a stranger's
 * corrupt submission, this one is the user's own real playtime, and discarding it
 * would be discarding the thing they came for.
 */
export const HOURS_PLAYED_MAX = 9999.9;

export function minutesToHoursClamped(minutes: number | undefined): number {
  if (!minutes || minutes <= 0) return 0;
  return Math.min(Math.round((minutes / 60) * 10) / 10, HOURS_PLAYED_MAX);
}

export type ImportItem = { uid: string; hours: number };

export type ImportResult = {
  total: number;
  matched: number;
  inserted: number;
  updated: number;
  viaParent: number;
  unmatched: string[];
};

/**
 * Resolve store ids to catalog games and write them into the caller's library.
 *
 * Two calls, both under the caller's JWT: one to resolve, one to write. Neither
 * touches IGDB — that is what game_external_ids bought, and why an import of a
 * 4,000-game library fits inside an edge function's 2s CPU budget.
 */
export async function importToLibrary(
  supabase: RpcClient,
  source: "steam" | "xbox" | "psn",
  items: ImportItem[],
): Promise<ImportResult> {
  if (items.length === 0) {
    return { total: 0, matched: 0, inserted: 0, updated: 0, viaParent: 0, unmatched: [] };
  }

  const { data: resolved, error } = await supabase.rpc("shelf_resolve_external_ids", {
    p_source: source,
    p_uids: items.map((i) => i.uid),
  });
  if (error) throw new Error(`resolve failed: ${error.message}`);

  // jsonb, so exactly one value comes back and PostgREST's max-rows cap cannot
  // apply. It used to be `setof` and was silently truncated at 1,000 — see
  // 20260914120000_resolve_returns_jsonb.sql.
  const rows = (resolved ?? []) as { uid: string; game_id: string; via_parent: boolean }[];
  const byUid = new Map(rows.map((r) => [r.uid, r]));

  const payload = items.flatMap((item) => {
    const hit = byUid.get(item.uid);
    return hit ? [{ game_id: hit.game_id, uid: item.uid, hours: item.hours }] : [];
  });

  // Deduping to one row per game happens in SQL, not here — see shelf_import_library.
  const { data: counts, error: importError } = await supabase.rpc("shelf_import_library", {
    p_source: source,
    p_items: payload,
  });
  if (importError) throw new Error(`import failed: ${importError.message}`);

  const first = ((counts ?? []) as { inserted: number; updated: number }[])[0];

  return {
    total: items.length,
    matched: payload.length,
    inserted: first?.inserted ?? 0,
    updated: first?.updated ?? 0,
    viaParent: rows.filter((r) => r.via_parent).length,
    // Capped: the app shows a count, not a list, and a 4,000-game library with a
    // 12% miss rate would otherwise put 500 ids in a response nobody reads.
    unmatched: items.filter((i) => !byUid.has(i.uid)).slice(0, 50).map((i) => i.uid),
  };
}
