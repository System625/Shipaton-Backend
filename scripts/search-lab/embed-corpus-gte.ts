// Embed the corpus with gte-small, locally — no API, no key, no rate limit.
//
//   npx tsx scripts/search-lab/embed-corpus-gte.ts
//
// The counterpart to embed-corpus.ts, which goes through Voyage. Same rows, same
// `doc` text, different model, a second column. Running both is the point: it is
// the only way to say what the free-forever option actually costs in recall
// against the best available one.
//
// Resumable and idempotent — it reads only rows where `embedding_gte is null`.
import { admin } from "../supabase-admin.ts";
import { gteEmbed, gteReady } from "./gte.ts";

const BATCH = 64;   // inference batch
const PAGE = 512;   // rows fetched per round trip

type Row = { game_id: string; doc: string };

/** Keyset pagination, not offset — an unordered `.range()` reads a different slice
 *  each call and silently covers only part of the table. */
async function nextUnembedded(afterId: string | null): Promise<Row[]> {
  let q = admin.from("search_vec_lab")
    .select("game_id, doc")
    .is("embedding_gte", null)
    .order("game_id", { ascending: true })
    .limit(PAGE);
  if (afterId) q = q.gt("game_id", afterId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Row[];
}

/** A single dropped connection should not end a 30-minute run. The job is
 *  resumable, but only if it gets to the end or is noticed; a mid-run death at
 *  5,632 of 17,106 rows looks exactly like a finished job in a log tail. */
async function writeWithRetry(rows: Record<string, unknown>[]) {
  for (let attempt = 0; ; attempt++) {
    try {
      const { error } = await admin.from("search_vec_lab").upsert(rows, { onConflict: "game_id" });
      if (!error) return;
      if (attempt >= 4) throw new Error(`write failed: ${error.message}`);
      console.warn(`  write error (${error.message}), retry ${attempt + 1}/5`);
    } catch (e) {
      // supabase-js surfaces a dropped connection as a thrown TypeError, not as
      // `error`, so both paths have to be caught or the run dies on a blip.
      if (attempt >= 4) throw e;
      console.warn(`  write threw (${(e as Error).message}), retry ${attempt + 1}/5`);
    }
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
}

async function main() {
  const { count: remaining } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true }).is("embedding_gte", null);
  console.log(`${remaining} rows to embed with gte-small (local, free, unmetered)`);

  const t0 = Date.now();
  await gteReady();
  console.log(`model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  let afterId: string | null = null;
  let done = 0;
  const started = Date.now();

  for (;;) {
    const page = await nextUnembedded(afterId);
    if (!page.length) break;

    for (let i = 0; i < page.length; i += BATCH) {
      const slice = page.slice(i, i + BATCH);
      const vectors = await gteEmbed(slice.map((r) => r.doc));
      await writeWithRetry(
        slice.map((r, j) => ({ game_id: r.game_id, doc: r.doc, embedding_gte: JSON.stringify(vectors[j]) })),
      );
      done += slice.length;
    }

    const mins = (Date.now() - started) / 60_000;
    console.log(`  ${done}/${remaining}  ${(done / Math.max(mins, 0.01)).toFixed(0)}/min`);
    afterId = page[page.length - 1].game_id;
  }

  const { count: stillNull } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true }).is("embedding_gte", null);
  console.log(`\ndone: ${done} embedded in ${((Date.now() - started) / 60_000).toFixed(1)} min, ${stillNull} still null`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
