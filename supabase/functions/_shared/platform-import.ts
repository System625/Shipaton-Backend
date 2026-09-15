// The platform-agnostic half of an import: clamp, resolve, write, report.
//
// Steam and Xbox are the two callers. `importToLibrary` below is the Steam shape
// — one source resolves and writes under the same name. Xbox needs a second
// function, `importXboxLibrary`, because its resolution is two-stage: a
// deterministic id bridge first (game_external_ids source 'xbox_title', DIFFERENT
// from the 'xbox' write source — see 20260915170000_xbox_title_source.sql), then
// shelf_search_games as a name-match fallback for the ~37-44% the bridge misses
// (docs/research/account-linking.md §4a measured 62.9%/55.6%). Both still land in
// the same shelf_import_library call, one write, source_kind='xbox' either way.

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

export type XboxTitleItem = { titleId: string; name: string };

export type XboxImportResult = ImportResult & {
  // Of `matched`, how many came from each path — the number Josh's 70%/50%
  // thresholds were about, now visible per real import rather than only in the
  // lab measurement.
  viaTitleId: number;
  viaNameMatch: number;
};

// The confidence floor `shelf_search_games` callers use everywhere else in this
// backend — see the comment on shelf_catalog_row.score. Not a new number invented
// for Xbox.
const NAME_MATCH_CONFIDENT = 0.55;

/**
 * Xbox's two-stage resolve. `shelf_resolve_external_ids('xbox_title', ...)` first
 * — deterministic, cannot mis-match — then `shelf_search_games` for whatever it
 * misses. Both feed the SAME shelf_import_library call, so a title-id match and a
 * name match are indistinguishable in the library afterward; only this function's
 * return value tells them apart, for STATUS/reporting rather than for the write.
 *
 * HOURS ARE NOT WIRED UP. OpenXBL exposes playtime only via a separate
 * `POST /api/v2/player/stats` call (MinutesPlayed per titleId), which is a third
 * unverified response shape on top of the two already flagged in _shared/xbox.ts
 * — not built this session. Every row this writes carries `hours: 0`, which reads
 * as "played zero hours" rather than "hours unknown". Flagged here rather than
 * silently shipped: the app should not display hours for xbox-sourced rows until
 * this is built, the same way it must not call Steam's `total` a library size.
 */
export async function importXboxLibrary(
  supabase: RpcClient,
  titles: XboxTitleItem[],
): Promise<XboxImportResult> {
  if (titles.length === 0) {
    return { total: 0, matched: 0, inserted: 0, updated: 0, viaParent: 0, unmatched: [], viaTitleId: 0, viaNameMatch: 0 };
  }

  const { data: resolved, error } = await supabase.rpc("shelf_resolve_external_ids", {
    p_source: "xbox_title",
    p_uids: titles.map((t) => t.titleId),
  });
  if (error) throw new Error(`resolve failed: ${error.message}`);

  const bridged = (resolved ?? []) as { uid: string; game_id: string; via_parent: boolean }[];
  const byTitleId = new Map(bridged.map((r) => [r.uid, r]));

  const items: { game_id: string; uid: string; hours: number }[] = [];
  const unmatched: string[] = [];
  let viaNameMatch = 0;

  for (const t of titles) {
    const hit = byTitleId.get(t.titleId);
    if (hit) {
      items.push({ game_id: hit.game_id, uid: t.titleId, hours: 0 });
      continue;
    }
    // The fallback: one shelf_search_games call per unresolved title. This is the
    // same per-item cost share ingestion already pays for a TikTok/YouTube link,
    // not a new shape — see docs/research/account-linking.md §4a for why this is
    // the right call now that the bridge clears 62.9%, not 100%.
    const { data: hits } = await supabase.rpc("shelf_search_games", { q: t.name, max_results: 1 });
    const top = ((hits ?? []) as { id: string; score: number }[])[0];
    if (top && top.score >= NAME_MATCH_CONFIDENT) {
      items.push({ game_id: top.id, uid: t.titleId, hours: 0 });
      viaNameMatch++;
    } else {
      unmatched.push(t.titleId);
    }
  }

  const { data: counts, error: importError } = await supabase.rpc("shelf_import_library", {
    p_source: "xbox",
    p_items: items,
  });
  if (importError) throw new Error(`import failed: ${importError.message}`);

  const first = ((counts ?? []) as { inserted: number; updated: number }[])[0];

  return {
    total: titles.length,
    matched: items.length,
    inserted: first?.inserted ?? 0,
    updated: first?.updated ?? 0,
    viaParent: bridged.filter((r) => r.via_parent).length,
    viaTitleId: items.length - viaNameMatch,
    viaNameMatch,
    unmatched: unmatched.slice(0, 50),
  };
}
