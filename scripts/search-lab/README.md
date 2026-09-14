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

Of its 76 distinct answers, **70 (92%) are in the production catalog**, so the
ceiling is high; failures are retrieval failures, not missing games.

## `enrichment-sample.tsv`

166 hand-written enrichment paragraphs — one per game — in the voice the production
enrichment prompt should aim for: protagonist's visible features, setting, art
style, signature mechanic, difficulty reputation, nicknames.

It covers the 38 gold answers **and all 128 games that beat them** in the lexical
baseline, so it cannot flatter the result by enriching only correct answers.

Use it as the few-shot examples for the real enrichment prompt, and as a regression
fixture: whatever a model generates for these 166 should be about this good.

## The scratch table

The corpus lives in `search_lab_docs` in the live project — 7,250 games (≥20 IGDB
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
```

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

## Still to run

Needs a Voyage API key (free tier covers it) and an Anthropic key:

1. Generate enrichment for the corpus with Claude (Batch API).
2. Embed it with `voyage-4-lite`, `halfvec(512)`, HNSW.
3. Re-run both evals: vector-only, then +HyDE, then +`rerank-3-lite`.
4. Separately measure "LLM names the game, grounded through `shelf_search_games`".

Record each number in the table above. A change that does not move
`reddit-eval.tsv` did not work, however good it looked.
