// Score a vague-search retrieval pipeline against an eval set.
//
//   npx tsx scripts/search-lab/run-vague-eval.ts --mode vector
//   npx tsx scripts/search-lab/run-vague-eval.ts --mode fusion --verbose
//   npx tsx scripts/search-lab/run-vague-eval.ts --mode hyde --file vibe-eval.tsv
//
// Modes, in the order docs/research/semantic-search.md section 6 builds them:
//
//   vector  embed the raw user sentence, ANN over the enriched catalog docs
//   hyde    have DeepSeek expand the sentence into an imagined catalog description,
//           embed THAT, ANN. Compares a description to descriptions instead of a
//           question to descriptions.
//   llm     DeepSeek names the game; each title is grounded through the live
//           shelf_search_games so nothing hallucinated can ever be shown
//   fusion  llm + hyde merged, then rerank-3-lite over the union
//
// Report numbers from reddit-eval.tsv. The authored vibe set scored 13 points
// higher on the identical system, because whoever writes the queries reuses catalog
// vocabulary without noticing.
import { admin } from "../supabase-admin.ts";
import { RateLimiter, embed, rerank, estimateTokens, DEFAULT_TPM, DEFAULT_RPM } from "./voyage.ts";
import { understand, balance, spendSummary, spend, type Understanding } from "./deepseek.ts";
import { gteEmbed } from "./gte.ts";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const flag = (n: string) => process.argv.includes(`--${n}`);
const opt = (n: string, d: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const MODE = opt("mode", "vector") as "vector" | "hyde" | "llm" | "fusion";
// Which embedding model retrieval runs on. They are not interchangeable at
// runtime: a query must be embedded by the same model as the corpus, so this
// switches both the column searched and the client used.
//   gte     Supabase's built-in gte-small, 384d, local/in-function. Free, unmetered.
//   voyage  voyage-4-lite, 512d. Better, but 3 req/min until the key's org has a
//           payment method — which is not a production query path.
const EMBEDDER = opt("embedder", "gte") as "gte" | "voyage";
const FILE = opt("file", "reddit-eval.tsv");
const K = Number(opt("k", "5"));
const CANDIDATES = Number(opt("candidates", "50"));
const RERANK = flag("rerank");
// Which DeepSeek model does the naming. `deepseek-flash` is the 15 Sep baseline;
// `deepseek-v4-pro` is the stronger one. Worth testing, because the LLM naming step
// is doing ~97% of the work (embeddings rescue 1 query in 71), so the model is the
// cheapest lever left.
const MODEL = opt("model", "deepseek-flash");
const verbose = flag("verbose");

const NOT_SCORED = new Set(["distractor-none", "Backbone"]);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// DeepSeek costs ~0.7c and up to 30s per query, so an understanding is cached on
// disk and shared by every mode that needs one. Delete the file to re-measure.
const CACHE_DIR = join(here, "cache");
const CACHE_FILE = join(CACHE_DIR, `understanding.${MODEL}.json`);
type Cache = Record<string, Understanding>;
const cache: Cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
const saveCache = () => {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
};

const rows = readFileSync(join(here, FILE), "utf8").trim().split("\n").slice(1)
  .map((l) => { const [query, gold] = l.split("\t"); return { query, gold }; })
  .filter((r) => r.query && r.gold && !NOT_SCORED.has(r.gold));

/** Understand every query first, with bounded concurrency, filling the cache. */
async function understandAll(queries: string[]) {
  const todo = queries.filter((q) => !cache[q]);
  if (!todo.length) return;
  // Check the balance BEFORE spending 25s x N on calls that will all 402. On
  // 16 Sep the account hit "Insufficient Balance" 60 queries into a run, which is
  // both a wasted wait and an unnecessarily confusing failure.
  const bal = await balance();
  if (bal && !bal.available) {
    throw new Error(
      `DeepSeek balance is exhausted (total ${bal.total}, is_available false) — ` +
      `every completion call will 402. Top up, or point --model at another provider.`,
    );
  }
  console.log(`understanding ${todo.length} queries via DeepSeek ${MODEL}` +
    ` (cached: ${queries.length - todo.length}` +
    (bal ? `, balance ${bal.total}` : "") + ")");
  let done = 0;
  const started = Date.now();
  const lat: number[] = [];
  const worker = async () => {
    for (;;) {
      const q = todo.shift();
      if (!q) return;
      const t = Date.now();
      cache[q] = await understand(q, { model: MODEL });
      lat.push(Date.now() - t);
      if (++done % 10 === 0) { saveCache(); console.log(`  ${done} understood`); }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  saveCache();
  const sorted = lat.slice().sort((a, b) => a - b);
  console.log(
    `  understanding done in ${((Date.now() - started) / 1000).toFixed(0)}s  ` +
    `median ${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)}s  ` +
    `p90 ${(sorted[Math.floor(sorted.length * 0.9)] / 1000).toFixed(1)}s  ` +
    `max ${(sorted[sorted.length - 1] / 1000).toFixed(1)}s`,
  );
  console.log(`  cost: ${spendSummary()}`);
}

// gameId, not title, is the identity. The catalog holds five rows titled
// "Resident Evil" and four titled "Resident Evil 4" since the 15 Sep widening, so
// deduplicating a merged candidate list by title silently collapses real rows.
type Candidate = { gameId: string; title: string; doc: string; from: string };

async function vectorSearch(text: string, limiter: RateLimiter, n: number): Promise<Candidate[]> {
  if (!text.trim()) return [];
  const vector = EMBEDDER === "gte"
    ? (await gteEmbed([text]))[0]
    : (await embed([text], "query", limiter, estimateTokens(text))).vectors[0];
  const rpc = EMBEDDER === "gte" ? "shelf_vec_lab_search_gte_txt" : "shelf_vec_lab_search_txt";
  const { data, error } = await admin.rpc(rpc, { q: JSON.stringify(vector), n });
  if (error) throw new Error(error.message);
  return (data ?? []).map((d: any) => ({
    gameId: d.game_id as string, title: d.title as string, doc: (d.doc as string) ?? "", from: "vec",
  }));
}

/** Ground a model-produced title against the real catalog. A title the catalog
 *  cannot confirm is never returned — the whole hallucination defence. */
async function ground(titles: string[]): Promise<Candidate[]> {
  if (!titles.length) return [];
  // One round trip for all five candidate titles, through shelf_ground_titles
  // rather than shelf_search_games. Two reasons, both measured 16 Sep 2026:
  //
  // 1. shelf_search_games is built for a human typing a fragment and costs
  //    ~0.5-1.1s per call; five serial calls put 5.5s on top of a DeepSeek call
  //    that already takes 25s at the median. The lean version is 1.07s for five.
  // 2. Calling it with `sort_by => null` — which is NOT the same as omitting the
  //    argument and taking `default 'best_match'` — makes every `case when
  //    sort_by = ...` branch in its ORDER BY evaluate to NULL and collapses the
  //    ranking to the `g.id` tiebreak. That returned `Sekiro: Shadows Die Twice`
  //    (score 1.0) third behind two 0.3 rows, and scored this step 0% on all 71
  //    queries before it was spotted. Fixed for good in migration
  //    20260916100000_search_sort_null_safe.sql.
  const out: Candidate[] = [];
  let rows: any[] | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await admin.rpc("shelf_ground_titles", { titles, per: 1 });
    if (!res.error) { rows = res.data ?? []; break; }
    if (attempt === 2) throw new Error(`grounding: ${res.error.message}`);
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
  for (const r of rows ?? []) {
    if (r.game_id) out.push({ gameId: r.game_id as string, title: r.title as string, doc: "", from: "llm" });
  }
  // The reranker needs something to read. A bare title tells a cross-encoder almost
  // nothing, so pull each grounded row's corpus doc where the corpus holds it.
  const missing = out.filter((c) => !c.doc).map((c) => c.gameId);
  if (missing.length) {
    const { data } = await admin.from("search_vec_lab").select("game_id, doc").in("game_id", missing);
    const docs = new Map<string, string>((data ?? []).map((d: any) => [d.game_id, d.doc]));
    for (const c of out) c.doc = docs.get(c.gameId) ?? c.title;
  }
  return out;
}

async function main() {
  const vecCol = EMBEDDER === "gte" ? "embedding_gte" : "embedding";
  const { count: embedded } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true }).not(vecCol, "is", null);
  const { count: corpus } = await admin.from("search_vec_lab")
    .select("*", { count: "exact", head: true });

  // The corpus is the rating>=5 tier, so a gold answer outside it can never be
  // retrieved by the vector modes. Scoring only over answerable queries keeps a
  // retrieval failure distinguishable from a coverage failure.
  // Two plain queries rather than one embedded-resource filter: PostgREST's
  // `games.title=in.(...)` chokes on the commas, colons and apostrophes in real
  // game titles, and fails by returning zero rows rather than by erroring.
  const golds = [...new Set(rows.map((r) => r.gold))];
  const { data: goldGames, error: gErr } = await admin.from("games")
    .select("id, title").in("title", golds);
  if (gErr) throw new Error(gErr.message);
  const idToTitle = new Map<string, string>((goldGames ?? []).map((g: any) => [g.id, g.title]));
  const { data: inCorpus, error: cErr } = await admin.from("search_vec_lab")
    .select("game_id").in("game_id", [...idToTitle.keys()]);
  if (cErr) throw new Error(cErr.message);
  const have = new Set((inCorpus ?? []).map((r: any) => norm(idToTitle.get(r.game_id)!)));
  const answerable = rows.filter((r) => have.has(norm(r.gold)));

  console.log(`=== ${FILE} — mode ${MODE}, embedder ${EMBEDDER}, model ${MODEL} ===`);
  console.log(`corpus:   ${embedded}/${corpus} rows embedded (${vecCol})`);
  console.log(`scored:   ${answerable.length} of ${rows.length} queries (gold present in corpus = the ceiling)`);
  if ((embedded ?? 0) < (corpus ?? 1) && MODE !== "llm") {
    console.log(`WARNING: corpus only ${(((embedded ?? 0) / (corpus ?? 1)) * 100).toFixed(0)}% embedded — this number is a floor, not the result.`);
  }

  if (MODE !== "vector") await understandAll(answerable.map((r) => r.query));

  const limiter = new RateLimiter(Number(opt("tpm", String(DEFAULT_TPM))), Number(opt("rpm", String(DEFAULT_RPM))));
  let hit1 = 0, hitK = 0;
  const misses: string[] = [];

  for (const r of answerable) {
    const u = cache[r.query];
    let cands: Candidate[] = [];

    if (MODE === "vector") cands = await vectorSearch(r.query, limiter, K);
    else if (MODE === "hyde") cands = await vectorSearch(u.hyde || r.query, limiter, K);
    else if (MODE === "llm") cands = await ground(u.titles);
    else {
      // fusion: the model's own named titles first (highest precision), then the
      // HyDE neighbourhood, then let the cross-encoder decide the final order.
      const [named, vec] = await Promise.all([
        ground(u.titles),
        vectorSearch(u.hyde || r.query, limiter, CANDIDATES),
      ]);
      const seen = new Set<string>();
      const union = [...named, ...vec].filter((c) => {
        const k = norm(c.title);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      // Reranking is OFF by default. `rerank-3-lite` carries the same 3 req/min
      // throttle as the embedding endpoint, and Supabase's edge runtime offers no
      // reranker at all, so a reranked number would measure something the free
      // architecture cannot ship. --rerank turns it on to size the upper bound.
      if (RERANK && union.length > 1) {
        const order = await rerank(
          r.query, union.map((c) => c.doc || c.title),
          limiter, estimateTokens(r.query) + union.reduce((a, c) => a + estimateTokens(c.doc || c.title), 0),
        );
        cands = order.map((o) => union[o.index]);
      } else cands = union;
    }

    const titles = cands.map((c) => norm(c.title)).slice(0, K);
    const gold = norm(r.gold);
    if (titles[0] === gold) hit1++;
    if (titles.includes(gold)) hitK++;
    else misses.push(`  want ${r.gold}\n    q: ${r.query.slice(0, 90)}\n    got: ${cands.slice(0, K).map((c) => c.title).join(" | ") || "(nothing)"}`);
  }

  const pct = (n: number) => `${n}/${answerable.length} = ${(n / answerable.length * 100).toFixed(1)}%`;
  console.log(`recall@1: ${pct(hit1)}`);
  console.log(`recall@${K}: ${pct(hitK)}`);
  if (verbose && misses.length) console.log(`\n--- misses ---\n${misses.join("\n")}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
