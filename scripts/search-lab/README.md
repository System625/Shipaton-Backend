# search-lab — the vague-search measurement harness

Everything here exists to answer one question with a number instead of an opinion:
**given a half-remembered description, do we return the right game?**

Read `docs/research/semantic-search.md` first. This directory is the evidence
behind it.

## The eval sets

| File | Queries | Where it came from | Trust |
|---|---:|---|---|
| `reddit-eval.tsv` | 77 | Real posts on r/tipofmyjoystick. The subreddit sets a solved post's flair to the game's name, so the answer key is the flair — no comment scraping, no judgement call. | **High. Hill-climb against this one.** |
| `vibe-eval.tsv` | 40 | Written by hand in the style of Josh's examples. | **Low. Sanity check only.** |

`vibe-eval.tsv` scored **13 points higher** than `reddit-eval.tsv` on the same
system, because whoever writes the queries unconsciously reuses catalog vocabulary.
That gap is the single best argument for never trusting a self-authored eval. Keep
it for quick smoke tests; report numbers from the reddit set.

Two rows in `vibe-eval.tsv` are deliberate: `distractor-none` has no correct answer
(the system should return nothing confident), and `Backbone` is a game absent from
the catalog. Both are excluded from scoring by the harness.

### Caveat that must travel with any number from `reddit-eval.tsv`

r/tipofmyjoystick skews hard toward obscure childhood games — flash games,
edutainment, shovelware. Of 990 solved posts harvested, most answers are titles no
commercial catalog carries; only 77 survived filtering to "describable in text, and
plausibly in a games catalog".

Shelf's actual case — *a game they saw on TikTok two days ago* — skews recent and
popular, which is much easier. So treat this set as a **hard lower bound**. If it
scores 70%, the real feature is doing better than 70%.

Of its 76 distinct answers, **73 (96%) are in the production catalog** as of the
15 Sep widening — re-counted 16 Sep, up from 70 before it. The ceiling is high;
failures are retrieval failures, not missing games.

## `enrichment-sample.tsv`

166 hand-written enrichment paragraphs — one per game — in the voice the production
enrichment prompt should aim for: protagonist's visible features, setting, art
style, signature mechanic, difficulty reputation, nicknames.

It covers the 38 gold answers **and all 128 games that beat them** in the lexical
baseline, so it cannot flatter the result by enriching only correct answers.

Use it as the few-shot examples for the real enrichment prompt, and as a regression
fixture: whatever a model generates for these 166 should be about this good.

## The scratch tables

There are two, for two different eras of this work.
`search_vec_lab` (16 Sep, 17,106 rows) is the embedding corpus and the live one —
see "The corpus" below. `search_lab_docs` is the original lexical-baseline pull
and is described here because the 11 Sep numbers above came from it.

The lexical corpus lives in `search_lab_docs` in the live project — 7,250 games (≥20 IGDB
ratings, all game types) with `summary`, `storyline`, `themes`, `genres`,
`keywords`, `perspectives`, `modes`, `steam_appid`, `steam_tags` and `enrichment`,
plus a weighted `tsvector` and `shelf_lab_search()`.

**It is not part of the product schema.** It has RLS on and no policies, so only the
service role can read it. Drop it when the research is finished:

```sql
drop table if exists search_lab_docs cascade;
drop function if exists shelf_lab_search(text, int);
drop function if exists shelf_lab_orquery(text);
drop function if exists shelf_lab_set_doc();

-- and the 16 Sep embedding corpus, once the model choice is settled
drop table if exists search_vec_lab cascade;
drop function if exists shelf_vec_lab_search(extensions.halfvec, int);
drop function if exists shelf_vec_lab_search_txt(text, int);
drop function if exists shelf_vec_lab_search_gte(extensions.vector, int);
drop function if exists shelf_vec_lab_search_gte_txt(text, int);
```

Both were created with `execute_sql`, deliberately, not `apply_migration` — scratch
objects must not leave rows in the migration ledger that no local file explains.

## Measured so far (11 Sep 2026)

Lexical FTS over everything we can get — the "just index what we have" approach,
run three times, adding a content source each time:

| Index contains | vibe @1 | vibe @5 | **reddit @1** | **reddit @5** |
|---|---:|---:|---:|---:|
| IGDB text only | 13% | 24% | **0%** | **2%** |
| \+ hand-written enrichment | 16% | 26% | **0%** | **2%** |
| \+ SteamSpy crowd tags | 18% | 32% | **0%** | **2%** |

**The real column never moved.** Descriptions containing the literal answer, plus
thousands of crowd-voted tags, bought nothing. That is the result: the content was
never the problem, the matching method was. See §3 of the research doc.

The `vibe` column drifting up while `reddit` stays flat is the self-authored-eval
bias showing itself in real time — Steam tags match the vocabulary I used when
writing those queries, and nobody else's.

## Measured 15 Sep 2026 — LLM names the game (step 3), on DeepSeek

Josh sent a DeepSeek key instead of an Anthropic one. This is step 3 of
`docs/research/semantic-search.md` §8 measured **without** catalog grounding —
raw model knowledge, `reddit-eval.tsv`, exact-ish title match, @1 only. Grounding
through `shelf_search_games` is still to build; it should raise precision and
allow rejecting hallucinated titles.

| Config | reddit @1 | out tokens/query | wall/query |
|---|---:|---:|---:|
| lexical FTS baseline (11 Sep) | **0%** | — | ~0 |
| `deepseek-flash`, thinking OFF | **7.8%** | 2 | 0.2s |
| `deepseek-flash`, `reasoning_effort=minimal` | **40.3%** | 3,748 | ~23s |
| `deepseek-flash`, thinking ON, uncapped | **42.9%** | 5,574 | ~29s |

**0% → 43% is the whole result.** The method was the problem, exactly as §3 said.

Three things that must travel with these numbers:

1. **The reasoning is the capability.** With `thinking: {type:"disabled"}` the model
   answers `UNKNOWN` on 69 of 77. The cheap fast path is worthless here; you are
   buying the reasoning or you are buying nothing.
2. **Latency is the real constraint, not accuracy.** ~23-30s per query at 6-way
   concurrency. §7 of the research doc assumed "a second of latency is acceptable
   if the UI admits it" — that assumption does not survive contact. The instant
   trigram path underneath is now load-bearing, and the vague answer has to arrive
   asynchronously rather than "a beat later."
3. **A small `max_tokens` silently returns an empty string**, `finish_reason:
   "length"`, no error. A first run scored 27.3% purely from truncation at 900
   tokens; at 8,000 tokens 22/77 were still truncated. Budget ~24k, and treat
   empty content as a retry, not as "no answer".

Measured cost: **$0.71 for ~300 queries** (balance $36.98 → $36.27), so roughly
**0.7 cents per vague search** at uncapped reasoning.

`reddit-eval.tsv` is a hard lower bound (see the caveat above) — Shelf's real case
skews recent and popular, so the shipped feature should beat 43%.

## Measured 16 Sep 2026 — grounding, and the embedding model question

The Voyage key arrived. Using it changed less than expected, and **the interesting
result of the day is that the free option may not need it at all**.

### Step 3, grounded: 0% -> 42.3%

Step 3 measured end to end for the first time — DeepSeek names the game, every
title is confirmed against the real catalog, and nothing the catalog cannot
confirm is ever returned.

| Config | reddit @1 | reddit @5 |
|---|---:|---:|
| lexical FTS baseline (11 Sep) | **0%** | **2%** |
| `deepseek-flash`, ungrounded, @1 only (15 Sep) | **42.9%** | — |
| **`deepseek-flash` + catalog grounding (16 Sep)** | **42.3%** | **49.3%** |

Scored over the 71 of 77 queries whose answer is in the corpus. **Grounding costs
nothing in accuracy** — 42.3% against 42.9% is inside the noise on 71 queries —
**and it buys hallucination-immunity for free**, because a title the catalog cannot
resolve simply never appears.

### Latency, re-measured and worse than recorded

At 6-way concurrency over 71 queries: **median 25.7s, p90 68.8s, max 227.5s**.
The 15 Sep note said "23-30s"; the tail is far longer than that. §7 of the research
doc assumed "a second of latency is acceptable if the UI admits it" — that
assumption is dead twice over. **The vague answer must arrive asynchronously, and
the UI needs to survive a four-minute worst case.** Sola has to know this.

### Two bugs found by measuring, not by reading

**1. `sort_by => null` silently destroys the ranking.** `shelf_search_games` orders
through a chain of `case when sort_by = '<mode>' then ... end`, and `sort_by` was
the only sort parameter without a `coalesce` — `sort_dir` has one on the line above
it. An explicit null (which is *not* the same as omitting the argument and taking
`default 'best_match'`) makes every branch NULL, leaving the `g.id` tiebreak as the
only ordering:

```
shelf_search_games('Sekiro: Shadows Die Twice', 3, ..., sort_by => null)
  -> Dual Shadows (0.32) | Seal of Shadows (0.30) | Sekiro: Shadows Die Twice (1.00)
```

The exact match, scoring 1.0, came back third. Grounding took row 0, so **step 3
scored a flat 0/71 while the model was naming games correctly the whole time.**
`/search` defaults the parameter and rejects anything outside `SORTS`, so production
was never affected. Fixed in `20260916100000_search_sort_null_safe.sql`.

**2. Grounding through `shelf_search_games` is the wrong tool and is slow.** It is
built for a human typing a fragment — five union arms, an alt-title join, a
token-coverage arm, filters, a popularity-weighted sort — and costs **443ms-1.2s per
call**. A vague query grounds up to five titles, serially, on top of a 25s model
call. `shelf_ground_titles(titles text[], per int)` does all five in one round trip
using an exact-name btree probe with a trigram fallback: **5.5s -> 1.07s for five
titles**, and eight test titles all ground exactly at score 1.0.

### The Voyage key is rate limited, and that decides the architecture

`voyage-4-lite` and `rerank-3-lite` both work. But the key's organisation has **no
payment method**, and Voyage throttles such keys to **3 requests/minute and 10,000
tokens/minute** — measured, not read: the fourth request inside a minute returns 429
with a billing message. The 200M free tokens still apply; the card lifts the
throttle rather than starting a bill.

| | throttled (what we have) | with a card |
|---|---|---|
| embed the 17k corpus, one-off | ~6.5 hours | ~4 minutes |
| **embed each user's query, forever** | **3 searches/min app-wide** | fine |

The second row is the one that matters. **Three searches per minute across all users
is not a product**, and judging on 22 Oct would break it immediately. §7's "this
removes cost as a design constraint entirely" was right about price and never
checked rate limits.

### The way out: `gte-small`, which needs no key at all

Supabase Edge Functions ship an embedding model **inside the runtime** —
`new Supabase.ai.Session('gte-small')` — with no external call, no key, no
per-minute cap and no card. The same weights (`Supabase/gte-small`) run locally
through Transformers.js, so a number measured in this lab transfers directly to
production.

Measured locally: **550-580 docs/min**, so the whole 17,106-row corpus embeds in
**~30 minutes, free, and re-embedding after a prompt change is also free**.

What it costs: 384 dimensions against voyage-4-lite's 512, English only, and
**inputs truncated at 512 tokens** — measured: only **378 of 17,106 docs (2.2%)** exceed
it, and that uses the chars/4 estimate which runs ~15% high, so the true figure is
lower still.
`search_vec_lab` therefore carries **both** embeddings — `embedding` (Voyage,
`halfvec(512)`) and `embedding_gte` (`vector(384)`) — so the question "what does the
free option actually cost in recall" gets an answer instead of an opinion.

### The corpus

`search_vec_lab` — 17,106 games, the `total_rating_count >= 5` tier of the
production catalog, not the old 7,250-row `search_lab_docs` pull. That tier was not
chosen for convenience: it contains **all 73 of the 76 reddit-eval gold answers that
exist in the catalog at all**, the same ceiling as the full 91,806-row catalog, for
2.7x less embedding work. 71 of 77 queries are scorable against it.

Storage, re-measured: `halfvec(512)` is **exactly 1,032 bytes per row** (90 MB for
the full catalog). Note that §7's storage table was computed when the database was
108 MB; **it is now 266 MB of the 500 MB free cap**, so that table needs redoing
before anything is sized against it.

### The result that decides step 5: embeddings are not worth building

All four retrieval paths, `reddit-eval.tsv`, 71 scorable queries, corpus fully
embedded with `gte-small`:

| Path | reddit @1 | reddit @5 |
|---|---:|---:|
| lexical FTS (11 Sep) | 0% | 2% |
| **vector only**, raw query -> ANN | **0.0%** | **4.2%** |
| **HyDE**, model writes a description, embed that -> ANN | **22.5%** | **29.6%** |
| **llm**, model names it + catalog grounding | **42.3%** | **49.3%** |
| **fusion**, llm + HyDE merged (no rerank) | **42.3%** | **50.7%** |

**Embedding the raw query is worthless** — 0% @1, barely above the lexical baseline.
That is §6's question-vs-description shape mismatch, measured: a user's sentence and
a catalog description are different kinds of text, and cosine distance between them
means nothing. It also kills the idea of a fast synchronous vector path underneath
the slow LLM one.

**HyDE fixes most of that** (0% -> 22.5% @1) and is the single biggest justification
for the embedding architecture. But it still loses to simply asking the model.

**And fusion adds +1.4 points over the LLM alone.** Broken down per query:

```
answerable:                  71
DeepSeek returned NO title:   0   <- it always guesses; there is no "I don't know" gap to fill
LLM titles contained gold:   35
LLM MISSED but HyDE@5 hit:    1   <- the entire measured value of embeddings
```

**One query in 71.** The whole embedding stack — pgvector, a 17k-row corpus, an
embedding model on both sides, HNSW, a reranker — buys `Yuppie Psycho: Executive
Edition`. **Step 5 as specified is not worth building**, and the free `gte-small`
path is not a compromise to regret; it is more than the problem needs.

**The caveat that must travel with this.** The corpus is raw IGDB text, *not* the
LLM-written enrichment §6 assumed. §7 predicted enrichment is what makes embeddings
work, and that remains unmeasured here. What is measured: §3 already showed
enrichment moved the *lexical* number by nothing, and the gap to close is now 1.4
points rather than the 30 §9 predicted. The cheaper lever is the naming model, not
the corpus.

## Still to run

1. Vector-only, HyDE, and fusion recall on `embedding_gte` — the numbers that decide
   whether the free path ships.
2. The same on Voyage's `embedding`, as the upper bound the free path is measured
   against.
3. HNSW index, and its real size against the remaining free-tier headroom.
4. Whether reranking is worth having at all, given `rerank-3-lite` carries the same
   3 RPM throttle and Supabase's runtime offers no reranker.

Record each number in the tables above. A change that does not move
`reddit-eval.tsv` did not work, however good it looked.
