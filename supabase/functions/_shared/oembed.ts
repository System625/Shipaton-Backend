// Turning a shared TikTok / YouTube link into something searchable. Spec section 6.
//
// Both oEmbed endpoints are public and need no auth. They were verified working on
// 4 Sep 2026 — but from a laptop on a residential connection, NOT from an edge
// function. One cross-check report claims both throttle or 403 datacenter IPs.
// Unreproduced and unverified, but cheap to insure against: send a browser
// User-Agent, and cache every resolved URL. TikTok's endpoint is undocumented and
// offered as a courtesy; hammering it is the fastest way to lose it.
//
// FIRST TASK AFTER DEPLOY: call this against a real YouTube and a real TikTok link
// from the deployed function. If it 403s there and works locally, this is why, and
// the answer is OpenGraph tags on the page.

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type ShareProvider = "tiktok" | "youtube" | "other";

export function detectProvider(rawUrl: string): ShareProvider {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "other";
  }
  if (host === "youtube.com" || host === "youtu.be" || host.endsWith(".youtube.com")) {
    return "youtube";
  }
  if (host === "tiktok.com" || host.endsWith(".tiktok.com")) return "tiktok";
  return "other";
}

export type OEmbedResult = { title: string; authorName?: string };

export async function fetchOEmbed(
  rawUrl: string,
  provider: ShareProvider,
): Promise<OEmbedResult | null> {
  let endpoint: string;
  if (provider === "youtube") {
    endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(rawUrl)}&format=json`;
  } else if (provider === "tiktok") {
    endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(rawUrl)}`;
  } else {
    return null;
  }

  const res = await fetch(endpoint, { headers: { "User-Agent": BROWSER_UA } });
  if (!res.ok) return null;
  const body = (await res.json()) as { title?: string; author_name?: string };
  if (!body.title) return null;
  return { title: body.title, authorName: body.author_name };
}

// ---- Text extraction ----

const YT_NOISE =
  /(official|trailer|gameplay|review|walkthrough|reveal|announcement|part\s*\d+|ep\.?\s*\d+|episode\s*\d+|\d+k|4k|hd)/i;

/**
 * YouTube returns a clean title with trailing noise:
 *   "ELDEN RING - Official Gameplay Reveal"        -> "ELDEN RING"
 *   "Hollow Knight: Silksong - Announcement Trailer" -> "Hollow Knight Silksong"
 *
 * Split on the usual separators, then drop from the first noisy segment onward.
 * Everything before it is kept and rejoined with a space: a colon is very often
 * part of the real title ("Hollow Knight: Silksong"), and the join separator does
 * not matter because shelf_match_title() strips punctuation on both sides anyway.
 */
export function cleanYouTubeTitle(title: string): string {
  const parts = title.split(/\s+[-|–—]\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return title.trim();

  const kept: string[] = [];
  for (const part of parts) {
    if (kept.length > 0 && YT_NOISE.test(part)) break;
    kept.push(part);
  }
  return (kept.length > 0 ? kept.join(" ") : title).trim();
}

// People tag these on everything. They are never the game.
const HASHTAG_STOPLIST = new Set([
  "foryou", "foryoupage", "fyp", "fypage", "viral", "trending", "gaming", "gamer",
  "gamers", "tiktokgaming", "games", "game", "videogames", "videogame", "xyzbca",
  "capcut", "edit", "funny", "clips", "twitch", "streamer", "ps5", "xbox", "pc",
  "nintendo", "switch", "steam",
]);

/**
 * "#EldenRing" -> "elden ring". An all-lowercase "#eldenring" cannot be split
 * without a dictionary and stays concatenated, which is fine: pg_trgm scores
 * "eldenring" against "elden ring" at ~0.62, above the 0.55 confident threshold,
 * because only the word padding differs.
 */
function expandHashtag(tag: string): string {
  const bare = tag.replace(/^#/, "");
  const spaced = bare
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ");
  return spaced.trim().toLowerCase();
}

function stripEmoji(s: string): string {
  return s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, " ");
}

/**
 * Candidate search strings for a caption, best signal first:
 *   1. hashtags — on TikTok the strongest signal by a distance, because people tag
 *      the game even when the caption never names it
 *   2. quoted strings
 *   3. the whole caption with emoji and hashtags removed, as a fuzzy query
 */
export function extractCandidateTexts(text: string, provider: ShareProvider): string[] {
  if (provider === "youtube") {
    const cleaned = cleanYouTubeTitle(text);
    return dedupe([cleaned, text]);
  }

  const out: string[] = [];

  for (const tag of text.match(/#[\p{L}\p{N}_]+/gu) ?? []) {
    const expanded = expandHashtag(tag);
    const compact = expanded.replace(/\s+/g, "");
    if (expanded.length >= 3 && !HASHTAG_STOPLIST.has(compact)) out.push(expanded);
  }

  for (const m of text.match(/["“']([^"”']{3,60})["”']/gu) ?? []) {
    out.push(m.replace(/["“”']/g, "").trim());
  }

  const bare = stripEmoji(text)
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (bare.length >= 3) out.push(bare);

  return dedupe(out);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(item.trim());
    }
  }
  return out;
}
