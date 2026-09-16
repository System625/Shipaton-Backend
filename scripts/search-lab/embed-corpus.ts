// Embed the vague-search corpus into search_vec_lab.embedding.
//
//   npx tsx scripts/search-lab/embed-corpus.ts
//   npx tsx scripts/search-lab/embed-corpus.ts --tpm 3000000 --rpm 2000   # once billing is on
//
// Resumable and idempotent: it only reads rows where `embedding is null`, so
// killing it and re-running loses at most one batch. That matters because at the
// throttled rate (see voyage.ts) the full run is ~6 hours.
//
// The corpus is the `total_rating_count >= 5` tier — 17,106 of 91,806 games.
// That tier was not picked for convenience: it contains **all 73 of the 76
// reddit-eval gold answers that exist in the catalog at all**, the same ceiling
// as the full catalog, for 2.7x less embedding time (measured 16 Sep 2026).
import { admin } from "../supabase-admin.ts";
import { RateLimiter, embed, sleep, DEFAULT_TPM, DEFAULT_RPM } from "./voyage.ts";

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};

const TPM = arg("tpm", DEFAULT_TPM);
const RPM = arg("rpm", DEFAULT_RPM);
// Stay under the per-minute token budget in one request, and under Voyage's
// 1,000-input cap. The estimate (chars/4) runs ~15% ABOVE Voyage's real count, so
// 80% of the budget is comfortable — and overshooting costs a 20s backoff, while
// undershooting costs nothing, since one request per minute is the ceiling anyway.
const BATCH_TOKENS = Math.max(1_000, Math.floor(Math.min(TPM, 120_000) * 0.8));
const BATCH_ROWS = 1_000;

type Row = { game_id: string; doc: string; tokens: number };

/** Keyset pagination, not offset. An unordered `.range()` reads a different slice
 *  each call and silently returns a partial catalog — see the 12 Sep incident. */
async function nextUnembedded(afterId: string | null): Promise<Row[]> {
  let q = admin.from("search_vec_lab")
    .select("game_id, doc, tokens")
    .is("embedding", null)
    .order("game_id", { ascending: true })
    .limit(BATCH_ROWS);
  if (afterId) q = q.gt("game_id", afterId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

async function main() {
  const limiter = new RateLimiter(TPM, RPM);

  const { count: total } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true });
  const { count: remaining } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true }).is("embedding", null);

  console.log(`corpus ${total} rows, ${remaining} still to embed`);
  console.log(`limits ${TPM} tokens/min, ${RPM} req/min -> batch <= ${BATCH_TOKENS} tokens`);
  if (TPM === DEFAULT_TPM) {
    const hours = ((remaining ?? 0) * 230) / TPM / 60;
    console.log(`THROTTLED TIER: no payment method on the Voyage key. ETA ~${hours.toFixed(1)}h.`);
  }

  let afterId: string | null = null;
  let done = 0, spentTokens = 0;
  const started = Date.now();

  for (;;) {
    const page = await nextUnembedded(afterId);
    if (!page.length) break;

    // Pack the page into token-budgeted batches.
    let batch: Row[] = [];
    let batchTokens = 0;
    const flush = async () => {
      if (!batch.length) return;
      const { vectors, tokens } = await embed(
        batch.map((r) => r.doc), "document", limiter, batchTokens,
      );
      const updates = batch.map((r, i) => ({
        game_id: r.game_id,
        doc: r.doc,
        tokens: r.tokens,
        embedding: JSON.stringify(vectors[i]),
        embedded_at: new Date().toISOString(),
      }));
      // Retry the write. Losing a 7-hour throttled run to one dropped connection
      // costs the whole day, and supabase-js reports a dropped connection as a
      // thrown TypeError rather than as `error`, so both paths need catching.
      for (let attempt = 0; ; attempt++) {
        try {
          const { error } = await admin.from("search_vec_lab")
            .upsert(updates, { onConflict: "game_id" });
          if (!error) break;
          if (attempt >= 4) throw new Error(`write failed: ${error.message}`);
          console.warn(`  write error (${error.message}), retry ${attempt + 1}/5`);
        } catch (e) {
          if (attempt >= 4) throw e;
          console.warn(`  write threw (${(e as Error).message}), retry ${attempt + 1}/5`);
        }
        await sleep(2_000 * (attempt + 1));
      }

      done += batch.length;
      spentTokens += tokens;
      const mins = (Date.now() - started) / 60_000;
      const rate = done / Math.max(mins, 0.01);
      const left = ((remaining ?? 0) - done) / Math.max(rate, 0.01);
      console.log(
        `  ${done}/${remaining}  ${spentTokens.toLocaleString()} tok  ` +
        `${rate.toFixed(0)}/min  eta ${(left / 60).toFixed(1)}h`,
      );
      batch = [];
      batchTokens = 0;
    };

    for (const row of page) {
      if (batch.length && batchTokens + row.tokens > BATCH_TOKENS) await flush();
      batch.push(row);
      batchTokens += row.tokens;
    }
    await flush();
    afterId = page[page.length - 1].game_id;
  }

  const { count: stillNull } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true }).is("embedding", null);
  console.log(`\ndone: ${done} embedded this run, ${spentTokens.toLocaleString()} tokens, ${stillNull} still null`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
