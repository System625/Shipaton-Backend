// DeepSeek client for vague search — query understanding.
//
// Three facts about this API cost real time on 15 Sep 2026 and are encoded below
// rather than left as lore:
//
// 1. **The reasoning IS the capability.** With `thinking: {type:"disabled"}` the
//    model answers UNKNOWN on 69 of 77 reddit-eval queries and scores 7.8%. With
//    thinking on it scores 42.9%. There is no cheap fast path; do not "optimise"
//    by turning it off.
// 2. **A small `max_tokens` returns an EMPTY string**, `finish_reason: "length"`,
//    and no error field. A first run scored 27.3% purely from truncation at 900
//    tokens, and 22 of 77 were still truncated at 8,000. Hence MAX_TOKENS below,
//    and hence empty content is retried rather than read as "no answer".
// 3. **Latency is the constraint, not accuracy** — 23-30s per query. The product
//    consequence is in docs/research/semantic-search.md section 7: the vague answer
//    must arrive asynchronously, behind the instant trigram search.
//
// Models are `deepseek-flash` and `deepseek-v4-pro`. NOT `deepseek-chat` /
// `deepseek-reasoner`, which are the older names and are not what this key serves.
import { required } from "../env.ts";

const KEY = required("DEEPSEEK_API_KEY");
const URL = "https://api.deepseek.com/chat/completions";

// Per-model list price, USD per 1M tokens, PEAK rate (the pessimistic one) — from
// https://api-docs.deepseek.com/quick_start/pricing, checked 16 Sep 2026. Off-peak
// (outside 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri) is half of these.
// Reasoning tokens are billed as OUTPUT tokens, which is the whole cost here: a
// thinking-on query emits ~5,600 output tokens against ~300 input.
const PRICING: Record<string, { in: number; out: number }> = {
  "deepseek-flash": { in: 0.3, out: 1.2 },
  "deepseek-v4-pro": { in: 1.32, out: 3.96 },
};

/** Running total for this process, so a run's cost is never a mystery afterwards. */
export const spend = { calls: 0, inputTokens: 0, outputTokens: 0, usd: 0 };

export function spendSummary(): string {
  return `${spend.calls} calls, ${spend.inputTokens.toLocaleString()} in / ` +
    `${spend.outputTokens.toLocaleString()} out tokens, <= $${spend.usd.toFixed(3)} at peak rates`;
}

/**
 * Ask DeepSeek what the account has left. Returns null if the endpoint is
 * unreachable. `is_available: false` means every completion call will 402 with
 * "Insufficient Balance" — which is worth checking BEFORE a long run rather than
 * discovering 60 queries in.
 */
export async function balance(): Promise<{ available: boolean; total: string } | null> {
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    return { available: !!j.is_available, total: j.balance_infos?.[0]?.total_balance ?? "?" };
  } catch {
    return null;
  }
}

// Generous on purpose: see note 2 above. Reasoning tokens are counted here too,
// and a reasoning pass on a hard query ran to ~5,600 output tokens.
const MAX_TOKENS = 24_000;

export type Understanding = {
  /** Candidate titles, best guess first. Empty when the model genuinely does not know. */
  titles: string[];
  /** A HyDE passage: the catalog description this game would have, for embedding. */
  hyde: string;
  /** Confidence the model puts on `titles[0]`, 0-1. */
  confidence: number;
};

const SYSTEM = `You identify video games from vague, half-remembered descriptions.

Return STRICT JSON with exactly these keys:
{
  "titles": [up to 5 real game titles, most likely first, "" if you truly cannot guess],
  "hyde": "a 60-90 word description of the game, written the way a games catalog would describe it: setting, protagonist's visible features, art style, core mechanic, difficulty reputation",
  "confidence": 0.0 to 1.0 for how sure you are of titles[0]
}

Rules:
- Use the exact commercial title, no platform or edition suffix unless it is part of the name.
- If several games fit, list them all in "titles" rather than picking one and claiming certainty.
- ALWAYS write "hyde", even when "titles" is empty. When you do not know the game, describe the
  game the user is describing as if it existed — that passage is used for a similarity search,
  so concrete nouns matter more than hedging.
- Output JSON only. No markdown fence, no commentary.`;

/** Strip a ```json fence if the model adds one despite being told not to. */
function parseJson(raw: string): any {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Last resort: the first {...} block in the text.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`unparseable JSON: ${cleaned.slice(0, 200)}`);
  }
}

export async function understand(
  query: string,
  opts: { model?: string; thinking?: boolean } = {},
): Promise<Understanding> {
  const model = opts.model ?? "deepseek-flash";
  const thinking = opts.thinking ?? true;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: query }],
        max_tokens: MAX_TOKENS,
        ...(thinking ? {} : { thinking: { type: "disabled" } }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
        continue;
      }
      throw new Error(`deepseek ${res.status}: ${body.slice(0, 300)}`);
    }

    const json: any = await res.json();

    // Record usage on EVERY call, including the ones whose content is unusable.
    // A truncated reply still bills its reasoning tokens, so a retry loop that does
    // not count them under-reports the run's real cost.
    const usage = json.usage ?? {};
    const price = PRICING[model] ?? PRICING["deepseek-flash"];
    spend.calls += 1;
    spend.inputTokens += usage.prompt_tokens ?? 0;
    spend.outputTokens += usage.completion_tokens ?? 0;
    spend.usd += ((usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out) / 1e6;

    const choice = json.choices?.[0];
    const content: string = choice?.message?.content ?? "";

    // Note 2: truncation presents as empty content with finish_reason "length".
    // Treat it as a retry, never as "the model had no answer".
    if (!content.trim()) {
      console.warn(`  empty content (finish=${choice?.finish_reason}), retry ${attempt + 1}/4`);
      continue;
    }

    try {
      const parsed = parseJson(content);
      const titles = (Array.isArray(parsed.titles) ? parsed.titles : [])
        .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
        .slice(0, 5);
      return {
        titles,
        hyde: typeof parsed.hyde === "string" ? parsed.hyde : "",
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      };
    } catch (e) {
      console.warn(`  ${(e as Error).message}, retry ${attempt + 1}/4`);
    }
  }
  return { titles: [], hyde: "", confidence: 0 };
}
