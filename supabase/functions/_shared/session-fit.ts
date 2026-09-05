// session_fit: does this game work in a short evening?
//
// Derived from IGDB genres, game_modes and keywords — NOT from time to beat.
// Time to beat is total completion time; a session is an evening. Different
// quantities on different scales (spec section 7). Balatro's total playtime is
// effectively unbounded and it is the best 45-minute game there is, which is the
// clearest proof duration was never the right input.
//
// This is a heuristic over genre labels, not a measured property. First cut,
// to be revisited once anyone has actually used the roulette.

export type SessionFit = "high" | "medium" | "low";

const HIGH_GENRES = new Set([
  "racing", "sport", "fighting", "puzzle", "arcade", "pinball",
  "quiz/trivia", "card & board game",
]);

const MEDIUM_GENRES = new Set([
  "platform", "shooter", "hack and slash/beat 'em up", "music",
]);

const LOW_GENRES = new Set([
  "role-playing (rpg)", "strategy", "simulator", "turn-based strategy (tbs)",
  "real time strategy (rts)", "mmorpg",
]);

// Long-form narrative genres are only "low" once they are actually long.
const LONG_FORM_GENRES = new Set(["adventure", "visual novel", "point-and-click"]);

const HIGH_KEYWORDS = ["roguelike", "roguelite", "score attack", "endless", "arena"];

export function deriveSessionFit(input: {
  genres?: string[];
  gameModes?: string[];
  keywords?: string[];
  ttbNormallyHours?: number | null;
}): SessionFit {
  const genres = (input.genres ?? []).map((g) => g.toLowerCase());
  const modes = (input.gameModes ?? []).map((m) => m.toLowerCase());
  const keywords = (input.keywords ?? []).map((k) => k.toLowerCase());

  if (genres.some((g) => HIGH_GENRES.has(g))) return "high";
  if (keywords.some((k) => HIGH_KEYWORDS.some((h) => k.includes(h)))) return "high";
  if (modes.includes("battle royale")) return "high";

  if (genres.some((g) => LONG_FORM_GENRES.has(g)) && (input.ttbNormallyHours ?? 0) > 20) {
    return "low";
  }
  if (genres.some((g) => LOW_GENRES.has(g))) return "low";
  if (genres.some((g) => MEDIUM_GENRES.has(g))) return "medium";

  return "medium";
}
