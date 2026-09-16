// DeepSeek client for vague-search query understanding — the edge-runtime port of
// scripts/search-lab/deepseek.ts, which measured these facts on 15-16 Sep 2026 and
// they are encoded below rather than left as lore:
//
// 1. The reasoning IS the capability — `thinking: {type:"disabled"}` scored 7.8%
//    on reddit-eval.tsv against 42.9% with it on. There is no cheap fast path.
// 2. A small `max_tokens` returns an EMPTY string with `finish_reason: "length"`
//    and no error field — treat empty content as a retry, never as "no answer".
// 3. Latency is the constraint: median 25.7s, p90 68.8s, max 227.5s measured over
//    71 real queries. See vague-search-sweep/index.ts for how that shapes this.
//
// `model` is `deepseek-flash` or `deepseek-v4-pro` — NOT `deepseek-chat` /
// `deepseek-reasoner`, the older names this key does not serve.

const URL = "https://api.deepseek.com/chat/completions";
const MAX_TOKENS = 24_000;

export type Understanding = {
  /** Candidate titles, best guess first. Empty when the model genuinely does not know. */
  titles: string[];
  /** Confidence the model puts on titles[0], 0-1. */
  confidence: number;
};

const SYSTEM = `You identify video games from vague, half-remembered descriptions.

Return STRICT JSON with exactly these keys:
{
  "titles": [up to 5 real game titles, most likely first, "" if you truly cannot guess],
  "confidence": 0.0 to 1.0 for how sure you are of titles[0]
}

Rules:
- Use the exact commercial title, no platform or edition suffix unless it is part of the name.
- If several games fit, list them all in "titles" rather than picking one and claiming certainty.
- Output JSON only. No markdown fence, no commentary.`;

/** Strip a ```json fence if the model adds one despite being told not to. */
function parseJson(raw: string): any {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`unparseable JSON: ${cleaned.slice(0, 200)}`);
  }
}

/**
 * `signal` bounds the WHOLE call, retries included — the sweep passes one tied to
 * its own remaining budget (see vague-search-sweep/index.ts), because this can
 * legitimately take up to ~227s and the sweep must never let it run past what the
 * platform allows the invocation to live.
 */
export async function understand(
  query: string,
  opts: { model?: string; apiKey: string; signal?: AbortSignal },
): Promise<Understanding> {
  const model = opts.model ?? "deepseek-flash";

  for (let attempt = 0; attempt < 4; attempt++) {
    if (opts.signal?.aborted) throw new Error("understand: aborted (out of time)");

    const res = await fetch(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: query }],
        max_tokens: MAX_TOKENS,
      }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 3_000 * (attempt + 1)));
        continue;
      }
      throw new Error(`deepseek ${res.status}: ${body.slice(0, 300)}`);
    }

    const payload: any = await res.json();
    const choice = payload.choices?.[0];
    const content: string = choice?.message?.content ?? "";

    // Note 2 above: truncation presents as empty content, not an error.
    if (!content.trim()) continue;

    try {
      const parsed = parseJson(content);
      const titles = (Array.isArray(parsed.titles) ? parsed.titles : [])
        .filter((t: unknown): t is string => typeof t === "string" && t.trim().length > 0)
        .slice(0, 5);
      return {
        titles,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      };
    } catch {
      continue;
    }
  }
  return { titles: [], confidence: 0 };
}
