// gte-small embeddings, run locally — the no-API, no-key, no-card path.
//
// **Why this model and not a better one.** Voyage's key is throttled to 3 requests
// per minute unless a payment method is attached to the organisation (see
// voyage.ts). Three searches per minute app-wide is not a product. Supabase Edge
// Functions ship `gte-small` *inside the runtime* —
// `new Supabase.ai.Session('gte-small')` — with no external call, no key and no
// per-minute cap, so the production query path costs nothing and cannot be rate
// limited by a third party.
//
// These are the same weights (`Supabase/gte-small` on Hugging Face, the ONNX build
// Supabase's runtime uses), so a number measured here transfers to production.
// That is the whole reason to embed the corpus locally rather than through an API.
//
// Constraints that come with it, from Supabase's docs:
//   - 384 dimensions, against voyage-4-lite's 512. Smaller index, less signal.
//   - English only.
//   - **Inputs are truncated at 512 tokens.** Corpus docs average ~230 tokens so
//     most survive whole, but the long tail is clipped; doc-building should put the
//     high-signal text first.
import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const GTE_DIMS = 384;

let extractor: FeatureExtractionPipeline | null = null;

export async function gteReady(): Promise<FeatureExtractionPipeline> {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", "Supabase/gte-small");
  }
  return extractor;
}

/**
 * Embed a batch. `mean_pool: true, normalize: true` in the Supabase docs maps to
 * `pooling: "mean", normalize: true` here — the settings must match the production
 * call exactly or the corpus and the query land in different spaces.
 */
export async function gteEmbed(texts: string[]): Promise<number[][]> {
  const model = await gteReady();
  const out = await model(texts, { pooling: "mean", normalize: true });
  return out.tolist() as number[][];
}
