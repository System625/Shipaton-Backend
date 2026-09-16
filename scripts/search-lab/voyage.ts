// Voyage AI client — embeddings and reranking, with the rate limiter the key
// actually needs.
//
// **Read this before using it.** The key Josh sent on 16 Sep 2026 has no payment
// method attached to its organisation, and Voyage throttles such keys to
// **3 requests/minute and 10,000 tokens/minute** (measured, not recalled: the
// fourth request inside a minute returns HTTP 429 with a `detail` explaining the
// billing state). The 200M free tokens still apply either way — adding a card
// does not start a bill, it lifts the throttle. Until it is added:
//
//   - embedding the 17k-game corpus takes ~6 hours instead of ~4 minutes, and
//   - **query-time embedding is unusable in production**: 3 searches per minute
//     app-wide, shared across every user.
//
// So DEFAULT_TPM/RPM below are the throttled numbers. Once billing is on, pass
// --tpm/--rpm (see embed-corpus.ts) and everything here goes ~300x faster with
// no other change.
import { required } from "../env.ts";

const KEY = required("VOYAGE_API_KEY");
const BASE = "https://api.voyageai.com/v1";

// Throttled-tier limits, measured 16 Sep 2026. Voyage's standard tier for the
// series-3+ models is 2,000 RPM / 3M TPM.
export const DEFAULT_TPM = 10_000;
export const DEFAULT_RPM = 3;

/**
 * A **fixed-window** token+request limiter, aligned to the wall-clock minute.
 *
 * This deliberately is not a smoothly-refilling bucket. Voyage meters per calendar
 * minute, and a bucket that refills continuously will happily fire a second
 * 9k-token request 40 seconds into a minute that has already spent 7.5k — which is
 * a 429 every time. Measured on the first smoke run: one 429 per batch. Matching
 * their window shape removes them entirely.
 */
export class RateLimiter {
  private windowStart = 0;
  private tokensUsed = 0;
  private reqsUsed = 0;

  constructor(private tpm: number, private rpm: number) {}

  /** Block until `tokens` and one request fit inside the current minute. */
  async take(tokens: number) {
    // Keep 5% back: our pre-call estimate can run under Voyage's real count, and
    // overshooting the window costs a 20s backoff.
    const budget = Math.floor(this.tpm * 0.95);
    const want = Math.min(tokens, budget);
    for (;;) {
      const now = Date.now();
      const window = Math.floor(now / 60_000);
      if (window !== this.windowStart) {
        this.windowStart = window;
        this.tokensUsed = 0;
        this.reqsUsed = 0;
      }
      if (this.tokensUsed + want <= budget && this.reqsUsed + 1 <= this.rpm) {
        this.tokensUsed += want;
        this.reqsUsed += 1;
        return;
      }
      await sleep((window + 1) * 60_000 - now + 250);
    }
  }

  /** Record the true token count once Voyage reports it, so the window stays honest. */
  reconcile(actualTokens: number, estimatedTokens: number) {
    this.tokensUsed += Math.max(0, actualTokens - estimatedTokens);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(path: string, body: unknown, limiter: RateLimiter, costTokens: number) {
  // Up to 6 attempts. 429 here means the limiter's model of the budget drifted
  // from Voyage's (their window is per calendar minute, ours refills smoothly),
  // so back off hard rather than hammering.
  for (let attempt = 0; ; attempt++) {
    await limiter.take(costTokens);
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) {
      throw new Error(`voyage ${path} ${res.status}: ${text.slice(0, 300)}`);
    }
    const backoff = res.status === 429 ? 20_000 * (attempt + 1) : 2_000 * (attempt + 1);
    console.warn(`  ${res.status} on ${path}, backing off ${backoff / 1000}s (attempt ${attempt + 1}/6)`);
    await sleep(backoff);
  }
}

export type EmbedKind = "document" | "query";

/**
 * Embed a batch. `output_dimension: 512` is the Matryoshka setting chosen in
 * docs/research/semantic-search.md section 7 — halfvec(512) is the only width that
 * fits the full catalog inside the 500 MB free-tier cap.
 */
export async function embed(
  inputs: string[],
  kind: EmbedKind,
  limiter: RateLimiter,
  estTokens: number,
): Promise<{ vectors: number[][]; tokens: number }> {
  const json: any = await call("/embeddings", {
    model: "voyage-4-lite",
    input: inputs,
    input_type: kind,
    output_dimension: 512,
    output_dtype: "float",
    truncation: true,
  }, limiter, estTokens);

  // Voyage documents that `data` comes back in input order, but it also carries an
  // explicit index. Sort by it rather than trusting the order — a silently
  // mis-aligned embedding is invisible until recall is mysteriously bad.
  const vectors = json.data
    .slice()
    .sort((a: any, b: any) => a.index - b.index)
    .map((d: any) => d.embedding as number[]);
  if (vectors.length !== inputs.length) {
    throw new Error(`voyage returned ${vectors.length} vectors for ${inputs.length} inputs`);
  }
  const tokens = json.usage?.total_tokens ?? estTokens;
  limiter.reconcile(tokens, estTokens);
  return { vectors, tokens };
}

/** Cross-encoder rerank over candidates. Returns indices into `documents`, best first. */
export async function rerank(
  query: string,
  documents: string[],
  limiter: RateLimiter,
  estTokens: number,
  topK?: number,
): Promise<{ index: number; score: number }[]> {
  const json: any = await call("/rerank", {
    model: "rerank-3-lite",
    query,
    documents,
    top_k: topK ?? documents.length,
    truncation: true,
  }, limiter, estTokens);
  return json.data.map((d: any) => ({ index: d.index, score: d.relevance_score }));
}

/** Rough token estimate. Only used for budgeting; Voyage reports the true count. */
export const estimateTokens = (s: string) => Math.ceil(s.length / 4);
