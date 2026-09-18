// Hydrates a list of game ids into the CatalogGame shape every other endpoint
// returns, preserving the caller's ordering (best guess first) rather than
// whatever order `in()` happens to return.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { toCatalogGame, type CatalogGame, type CatalogRow } from "./catalog-game.ts";

export async function catalogGamesByIds(
  supabase: SupabaseClient,
  ids: string[],
): Promise<CatalogGame[]> {
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("games")
    .select(
      "id, title, slug, release_date, release_precision, genres, cover_url, critic_score, " +
      "ttb_normally_hours, ttb_count, session_fit, summary, " +
      "game_platforms(platforms(id, name, slug))",
    )
    .in("id", ids);
  if (error) throw new Error(error.message);

  const byId = new Map<string, CatalogRow>((data ?? []).map((row: any) => [
    row.id,
    {
      ...row,
      platforms: (row.game_platforms ?? []).map((gp: any) => gp.platforms).filter(Boolean),
    },
  ]));

  // A grounded/cached id that no longer resolves (a game deleted since) just
  // drops out rather than rendering a blank card.
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is CatalogRow => !!row)
    .map(toCatalogGame);
}
