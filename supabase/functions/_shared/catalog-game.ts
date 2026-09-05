// The CatalogGame contract the app consumes. Spec section 8.
// Every endpoint shapes its response through toCatalogGame() so the app sees one
// consistent object regardless of which endpoint produced it.

export type PlatformRef = { id: number; name: string; slug: string };

// NOTE: these keys must match Sola's `CoverColorKey` union in the app. They are a
// placeholder until that union is confirmed against the app repo — see docs/STATUS.md.
export const COVER_COLOR_KEYS = [
  "amber", "rose", "violet", "indigo", "teal", "emerald", "slate",
] as const;
export type CoverColorKey = (typeof COVER_COLOR_KEYS)[number];

export type CatalogGame = {
  id: string;
  title: string;
  platforms: PlatformRef[];
  releaseDate?: string;
  genres: string[];
  coverImageUrl?: string;
  timeToBeatHours?: number;
  sessionFit?: "high" | "medium" | "low";
  criticScore?: number;
  abbreviation: string;
  colorKey: CoverColorKey;
};

// The row shape returned by shelf_search_games / shelf_roulette.
export type CatalogRow = {
  id: string;
  title: string;
  slug: string | null;
  release_date: string | null;
  genres: string[] | null;
  cover_url: string | null;
  critic_score: number | null;
  ttb_normally_hours: number | string | null;
  ttb_count: number | null;
  session_fit: "high" | "medium" | "low" | null;
  platforms: PlatformRef[] | null;
  score?: number | null;
};

const NOISE_WORDS = new Set(["the", "of", "a", "an", "and", "de", "la", "el"]);

/**
 * Two or three letters for the coloured swatch the app falls back to when cover
 * art fails, which happens more often than you would expect. Derived server side
 * so the fallback is identical everywhere.
 */
export function deriveAbbreviation(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return title.slice(0, 2).toUpperCase() || "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join("").toUpperCase();
}

/** Stable per title, so a game keeps the same swatch across sessions and devices. */
export function deriveColorKey(title: string): CoverColorKey {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) >>> 0;
  }
  return COVER_COLOR_KEYS[hash % COVER_COLOR_KEYS.length];
}

export function toCatalogGame(row: CatalogRow): CatalogGame {
  const ttb = row.ttb_normally_hours == null ? undefined : Number(row.ttb_normally_hours);
  return {
    id: row.id,
    title: row.title,
    platforms: row.platforms ?? [],
    releaseDate: row.release_date ?? undefined,
    genres: row.genres ?? [],
    coverImageUrl: row.cover_url ?? undefined,
    timeToBeatHours: ttb,
    sessionFit: row.session_fit ?? undefined,
    criticScore: row.critic_score ?? undefined,
    abbreviation: deriveAbbreviation(row.title),
    colorKey: deriveColorKey(row.title),
  };
}
