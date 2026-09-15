# Vague search — "the game I saw two days ago"

Research for the feature Josh asked for in `docs/decisions-for-josh.md`:

> They wanna be able to search for a game they saw a day or two ago, like
> "Feudal Japan, guy with a metal arm, really hard." or "plumber pushing 40
> chasing princess".

**Researched 11 Sep 2026.** Every number below was measured against the live IGDB
API, the live Supabase project, or SteamSpy on that date. Nothing here is recalled
or estimated unless it says so. The measurement harness is described in §9 so the
numbers can be re-taken rather than trusted.

**The short version.** The feature is buildable and nothing about it is blocked.
But the obvious way to build it — index the text IGDB already gives us and search
it — was measured and **answers 0% of real queries**. The reason is not that the
content is thin; it is that the *matching method* is wrong, and no amount of better
content fixes it. What works is embeddings over LLM-written descriptions, plus the
model's own world knowledge at query time. There is also a catalog prerequisite:
~2,400 games people actually name are missing, including the Resident Evil 2 and 4
everyone means and Mario Kart 8 Deluxe.

---

## 1. The headline measurements

A corpus of **7,250 games** (every IGDB game with ≥20 user ratings, all game types)
was pulled with full descriptive text and loaded into Postgres with a weighted
`tsvector` over name, themes, genres, perspectives, modes, keywords, summary and
storyline. Two eval sets were then run against it.

| Index contains | Authored eval @1 | @5 | **Real eval @1** | **@5** |
|---|---:|---:|---:|---:|
| IGDB text only (summary, storyline, themes, keywords) | 13% | 24% | **0%** | **2%** |
| \+ hand-written LLM enrichment | 16% | 26% | **0%** | **2%** |
| \+ SteamSpy crowd tags | 18% | 32% | **0%** | **2%** |

The authored set is 38 queries I wrote in Josh's style. The real set is 77 queries
harvested from r/tipofmyjoystick with answers confirmed by the subreddit's own
solved-flair; 61 have an answer present in the corpus and are scored.

Four things to take from that table.

**Every content improvement failed on real queries.** Hand-written descriptions
containing the literal answer, plus thousands of crowd-voted Steam tags, moved the
real number by exactly nothing — 2%, three times. That is not a tuning problem.

**The real number is zero.** Not "needs tuning" — zero. Lexical search over IGDB's
own text does not answer this class of query at all.

**My own eval flattered it by 13 points, and that is a warning.** When I wrote the
queries myself I unconsciously reached for words that appear in catalog text. Real
users do not. Every future claim about this feature should be measured on queries
nobody on the team wrote.

**Even on the flattering eval, perfect content only bought 8 points** (24% → 32%),
and most of that came from Steam tags matching vocabulary I had used in the queries
myself. §3 explains why the ceiling is so low.

---

## 2. IGDB does not contain the signal, and Sekiro proves it

Josh's example is *"Feudal Japan, guy with a metal arm, really hard."* The answer is
Sekiro: Shadows Die Twice. Here is everything IGDB holds about Sekiro that could
match it:

```
SUMMARY:   "...action-adventure game set in a reimagined late 1500s Sengoku-era Japan.
            Players control Wolf, a shinobi on a mission to rescue his kidnapped lord..."
THEMES:    Action, Fantasy, Historical, Stealth
KEYWORDS:  ninja, japan, skill tree, the game awards 2017, sengoku period, shinobi,
           the game awards - best action-adventure game - winner,
           the game awards - best art direction - nominee,
           the game awards - best audio design - nominee,
           the game awards - best game direction - nominee,
           the game awards - game of the year - winner,
           the game awards - world premiere
```

Twelve keywords, seven of which are award-show trivia. And:

- **No mention of the prosthetic arm anywhere.** IGDB has no `prosthetic` keyword at
  all — checked against the keyword endpoint.
- **No mention of difficulty.** IGDB *does* have a `difficult` keyword (id 905),
  applied to 864 games including Elden Ring, Dark Souls, Bloodborne and Celeste. It
  is **not applied to Sekiro** — the hardest game FromSoftware has made. IGDB also
  has a `soulslike` keyword; Sekiro does not carry that either.
- **"Feudal Japan" is a real IGDB keyword — and it belongs to Ghost of Tsushima,
  not Sekiro.**

So on Josh's own example query, the catalog's own metadata actively ranks the wrong
game first. This is not a gap that better ranking fixes.

The second example, *"plumber pushing 40 chasing princess"*, is worse: no games
database will ever record that Mario is a plumber in his forties, because that is
cultural knowledge, not catalog metadata.

**What IGDB is good at**, measured, so this is not a case against IGDB:

| | |
|---|---|
| main games in IGDB | 306,110 |
| with ≥5 ratings (the population worth holding) | 15,053 |
| …of those carrying a `summary` | **15,021 (99.8%)** |
| …carrying a `storyline` | 5,385 (35.8%) |
| median summary + storyline length | 740 chars |
| mean keywords per game (top 100 by ratings) | 77 |

Coverage is excellent. The text is simply *descriptive of the product*, not of
*what a player remembers*.

---

## 3. Better content does not fix it — the matching method is wrong

I hand-wrote enrichment paragraphs for 166 games: the 38 gold answers **and all 128
games that beat them in the baseline**, so the test could not be rigged by enriching
only the right answers. Sekiro's says, in part:

> *"…you are Wolf, a one-armed shinobi whose severed left arm is replaced by a
> mechanical prosthetic… there is no difficulty setting and no summoning help, and
> it is widely considered the hardest game FromSoftware has made."*

That paragraph contains the answer to Josh's query in plain English. It is indexed
and searchable — verified: `prosthetic`, `sengoku` and `hardest` all resolve in
Sekiro's `tsvector`. Sekiro's Steam tags — `Souls-like`, `Difficult`, `Ninja` — are
in there too.

Recall on real queries stayed at 2%.

Here is why, and it is the single most useful diagram in this document. The query
reduces to these lexemes:

```
'arm' | 'feudal' | 'guy' | 'hard' | 'japan' | 'metal' | 'realli'
```

And here is what matches what:

| Game | feudal | metal | arm | hard | japan |
|---|:--:|:--:|:--:|:--:|:--:|
| **Sekiro: Shadows Die Twice** (right answer) | ✗ | ✗ | ✓ | ✗ | ✓ |
| Ghost of Tsushima | ✓ | ✗ | ✗ | ✗ | ✓ |
| Metal Gear Solid HD Collection | ✗ | ✓ | ✗ | ✗ | ✓ |
| **Metal Arms: Glitch in the System** | ✗ | ✓ | ✓ | ✗ | ✗ |

The user typed "metal arm". There is a game called **Metal Arms**. It is about a
robot. Lexical search will rank it first forever, no matter how good Sekiro's
description is, because `prosthetic` ≠ `metal`, `hardest` ≠ `hard` (different
stems), and `Sengoku` ≠ `feudal`.

**This is the finding that determines the architecture.** The three bridges the
feature needs — prosthetic ≈ metal arm, hardest ≈ really hard, Sengoku ≈ feudal
Japan — are all *semantic*. They require embeddings or an LLM. Keyword search,
trigram search, and BM25 cannot make any of them, and time spent tuning weights,
stemming or synonyms is wasted.

---

## 4. Where the missing signal can actually come from

Three sources, in descending order of coverage.

### 4a. Steam crowd tags — the best free source, but only half the catalog

SteamSpy returns Steam's user-voted tags with vote counts. For Sekiro:

```
Souls-like (2569), Difficult (2172), Action (2102), Singleplayer (1774),
Ninja (1622), Stealth (1302), Adventure (1198), Third Person (1187),
Open World (1076), Story Rich (969), Violent (856), Atmospheric (829),
Assassin (803), Dark Fantasy (717), Hack and Slash (707), RPG (684) …
```

`Difficult` and `Souls-like`, voted by thousands of players, in exactly the
vocabulary a user would type. This is the "really hard" signal, and it is free.

**The limitation is coverage, and it is exactly the wrong half:**

| | |
|---|---|
| IGDB games with ≥5 ratings | 15,053 |
| …with a Steam app id (`external_game_source = 1`) | **7,635 (50.7%)** |

The missing half is Nintendo and PlayStation exclusives — Ghost of Tsushima, Breath
of the Wild, and every Mario game, including the one in Josh's second example. So
Steam tags are a strong *supplement*, never the foundation.

Practicalities: SteamSpy documents 1 request/second for `appdetails`, so the whole
7,635-game backfill is about **2 hours 7 minutes**, one-off, re-runnable quarterly.
A 1,000-game sample was pulled during this research and is in `search_lab_docs`.

### 4b. LLM-written enrichment — full coverage, and the only source for "metal arm"

One paragraph per game, written by a model from the title, year, genres and IGDB
summary, answering *"how would someone who played this half-describe it?"* —
protagonist's visible features, setting, art style, signature mechanic, difficulty
reputation, nicknames and memes.

This is the only source that can contain "a prosthetic arm that fires grappling
hooks" or "a middle-aged Italian plumber", because that knowledge lives in the
model, not in any games database.

It also covers 100% of the catalog, including the Nintendo and PlayStation games
Steam misses.

The risk is hallucination — a model confidently writing that the wrong character has
a metal arm. Mitigations that matter: feed the real IGDB summary as grounding, keep
the paragraph short, and **treat enrichment as retrieval-only**. It should never be
shown to a user as fact; it exists to be embedded. A wrong sentence then costs one
bad search result, not a visible lie.

### 4c. Wikipedia / Wikidata — accurate, but a bigger job

Plot sections carry the concrete details ("prosthetic arm"). But joining IGDB to the
right Wikipedia article is its own matching problem with its own error rate, and
coverage of indie games is poor. **Not worth it before the deadline.** Revisit if
enrichment hallucination turns out to be a real measured problem rather than a
feared one.

---

## 5. Prerequisite: ~2,400 games people actually name are not in the catalog

This is a separate bug from search, found while testing, and it caps how good
search can ever look.

The seed filters to `game_type = 0 & parent_game = null & version_parent = null`.
That correctly removes "Deluxe Edition" and DLC noise. It also removes remakes,
remasters, ports and expanded editions — which are often *the version people mean*.

Measured against IGDB: **18,860 rows have ≥5 ratings; the catalog holds 15,012.**
The excluded rows with ≥5 ratings, by type:

| Type | Count | A user would call it a game? |
|---|---:|---|
| Port | 696 | yes |
| Expanded Game | 476 | yes |
| Expansion | 425 | usually |
| Remaster | 391 | yes |
| Remake | 325 | yes |
| Standalone Expansion | 154 | yes |
| Bundle | 495 | no |
| DLC | 394 | no |
| Episode / Mod / Season / Fork / Update / Pack | 262 | no |

**≈2,400 of those are standalone games somebody would name.** The most-rated ones:

| Ratings | Type | Game |
|---:|---|---|
| 1,703 | Remaster | The Last of Us Remastered |
| 1,632 | Expanded | Final Fantasy VII |
| 1,434 | Remake | **Resident Evil 2** (2019) |
| 817 | Remake | The Last of Us Part I |
| 687 | Remake | **Resident Evil 4** (2023) |
| 687 | Expanded | **Persona 5 Royal** |
| 641 | Expanded | **Mario Kart 8 Deluxe** |
| 575 | Remaster | Dark Souls: Remastered |

Checked against the live catalog, this is what is actually in there today:

- `Resident Evil 2` → the **1998 original** (598 ratings). The 2019 remake, with
  2.4× the ratings, is absent.
- `Resident Evil 4` → the **2005 original**. The 2023 remake is absent.
- `Mario Kart 8` → the **2014 Wii U version**. Deluxe, the Switch one everyone
  owns, is absent.
- `Persona 5 Royal`, `The Last of Us Part I`, `Dark Souls: Remastered` — all absent.

So a user describing RE2 ("rookie cop, police station, big guy in a trenchcoat")
gets the 1998 original with 1998 cover art. That reads as a broken feature even
though search worked perfectly.

Also found: **`Phoenix Wright: Ace Attorney` is missing entirely** — it is
`game_type = 10` (Expanded Game) with a parent, despite 314 ratings. Its sequels are
all present, which looks stranger than the whole series being absent.

**Fix before shipping search:** widen the seed to admit types 8, 9, 10, 11 and 4
(Remake, Remaster, Expanded Game, Port, Standalone Expansion) when
`total_rating_count >= 5`. Deliberately *not* type 2 (Expansion), which needs its
base game to make sense, nor Bundle or DLC.

> **SHIPPED 15 Sep 2026.** See §8 step 1 for what actually landed. Two corrections to
> what follows. **The admitted count held exactly** -- 2,043 rows against the 2,042
> measured here, and 510 colliding titles against the 510 measured here. **But this
> section's model of editions was wrong:** it assumed an edition is always
> `game_type = 0` plus a `version_parent`, so the widened pass could not admit one.
> 23 of the 2,043 carry a `version_parent` -- IGDB types "Deus Ex: Game of the Year
> Edition" as Expanded Game and "Bulletstorm: Full Clip Edition" as Remaster, not as
> type 0. They were kept: several are the canonical version people play, they carry
> suffixed titles so they never collide on exact match, none exceeds 100 ratings, and
> excluding them would have moved the pass off the number this decision was measured
> on. `npm run verify:seed-widening` pins that set at <= 50 rows, none >= 150 ratings,
> so a future re-typing of something major fails loudly instead of appearing in the
> catalog.

Measured against IGDB on 11 Sep:

| | |
|---|---|
| rows this admits | **2,042** |
| distinct titles among them | 1,882 |
| **titles that exactly match a row already in the catalog** | **510** |

That 510 is the whole decision. Widening means the catalog holds two rows called
`Resident Evil 2`, two called `Shadow of the Colossus`, two `GoldenEye 007`, two
`Tetris`. Three reasons to do it anyway:

- **They really are different games.** The 2019 RE2 is not the 1998 one. Search
  results carry `release_date` and distinct cover art, so the UI can already tell
  them apart. Today the user gets one row and it is usually the wrong one.
- **The ranking already resolves the tie correctly, with no code change.** Two rows
  with identical `match_title` get identical similarity, so the popularity term
  decides: RE2 2019 scores `0.15 × ln(1435)/ln(10001) = +0.118` against the 1998
  original's `+0.104`. The remake surfaces first, which is what people mean.
- **Nothing structurally objects.** `match_title` carries no unique constraint, only
  `igdb_id` does; `library_entries` keys on `games.id`, so a user can hold either or
  both.

The one thing to re-check after widening is `/share-resolve`'s `confident` flag.
`shelf_term_names_game()` is scoped to a single game id, so both duplicates pass it
equally and the flag follows whichever row ranked first. That is defensible — the
rejected row still comes back in `candidates` — but it is now asserting a specific
edition where before there was only one. Re-run `npm run measure:share` after the
re-seed and confirm the 14/21 hit rate did not move.

A useful sanity check on the target: of the 76 distinct answers in the real eval
set, **70 (92%) are in the production 89k catalog**. The ceiling is high. We are
not failing for lack of games — only for lack of a way to find them.

---

## 6. The architecture

Four stages. Stages 1 and 2 are the product; 3 and 4 are quality.

```
         user types a vague sentence
                    │
    ┌───────────────┼───────────────────┐
    │               │                   │
    ▼               ▼                   ▼
 (A) LLM         (B) HyDE            (C) filters
 names the       expand query        platform / era /
 game from       into a fake         "co-op", "hard"
 world           game description    parsed out
 knowledge       then embed it
    │               │                   │
    │               ▼                   │
    │        pgvector ANN over          │
    │        enriched game docs         │
    │               │                   │
    └──────► merge + ground ◄───────────┘
             (every candidate must
              resolve to a real row)
                    │
                    ▼
             rerank top ~50
                    │
                    ▼
              5 results + covers
```

**(A) Let the model just name it.** For any game with cultural footprint, a frontier
model already knows "feudal Japan, metal arm, really hard" is Sekiro. This is one
cheap call and it is the highest-precision path for exactly the queries Josh
described — a game you *saw*, so a game with reach. The output is then looked up
through the existing `shelf_search_games`, so grounding is free and already built.

**Grounding was measured, not assumed.** Of 39 gold titles, 37 are in the catalog,
and calling `shelf_search_games(title, 3)` on those 37 returns the right game at
**rank 1 for all 37**. The two failures are not ranking failures — `Backbone` and
`Phoenix Wright: Ace Attorney` are simply not in the catalog (§5). So once a model
produces a correct title, turning it into a real catalog row is a solved problem.

**Never show a title the model produced but the catalog cannot confirm.** That is
the whole hallucination defence, and it is one line of code.

**(B) HyDE, because it fits this problem unusually well.** Embedding a vague query
directly compares a *question* to *descriptions*, which are different shapes of
text. Instead, have the model expand "feudal japan, metal arm, really hard" into a
short imagined game description, and embed that. Now you are comparing a description
to descriptions. The same call that does (A) can emit both, so it costs nothing
extra.

**(C) Parse hard filters out of the sentence** — platform, rough era, "co-op",
"on Game Pass" — and apply them as SQL predicates, not as vector similarity.
pgvector 0.8's iterative index scans handle post-filtering without silently
returning too few rows.

**Rerank.** Vector search over ~90k items returns plausible-but-wrong neighbours.
A cross-encoder reranker over the top 50 is the single biggest quality-per-effort
win after embeddings themselves, and `rerank-3-lite` has a 200M-token free tier.

**Cache aggressively.** `search_cache` already exists. Vague queries repeat far more
than you would expect (the same TikTok trends the same week), and a cached answer is
free and instant. Note the contract in `docs/research/` that `/roulette` must never
be cached — this is the opposite case, cache it hard.

---

## 7. Infrastructure, cost and storage — all verified

### Embeddings

Anthropic does not offer an embeddings endpoint; Claude is the enrichment and
query-understanding model, not the embedding model. Verified against Voyage's own
pricing and docs on 11 Sep 2026:

| | |
|---|---|
| `voyage-4-lite` | **$0.02 / 1M tokens**, **first 200M tokens/month free** |
| context | 32,000 tokens |
| dimensions | 1024 default; Matryoshka 256 / 512 / 2048 |
| output dtype | float, int8, uint8, binary, ubinary |
| `rerank-3-lite` | $0.02 / 1M tokens, 200M free/month |
| batch API | additional 33% discount |

**Embedding the entire catalog is free.** 89,123 games at ~400 tokens of enrichment
each is ~36M tokens — 18% of one month's free allowance. Re-embedding after a prompt
change is also free. This removes cost as a design constraint entirely, which is
worth knowing before anyone optimises for it.

### Storage — the real constraint

The Supabase project is on the free tier: **108 MB used of 500 MB**, so ~390 MB
headroom. `vector` 0.8.2 is available and not yet installed (`pg_cron`, `pg_net` and
`pgmq` are available too, which is the standard Supabase pipeline for keeping
embeddings current).

| Scope | Type | Vectors | Index (HNSW, est.) | Total |
|---|---|---:|---:|---:|
| 16k rated games | `halfvec(512)` | 16 MB | ~18 MB | **~34 MB** |
| 89k full catalog | `halfvec(512)` | 91 MB | ~102 MB | **~193 MB** |
| 89k full catalog | `halfvec(1024)` | 182 MB | ~200 MB | 382 MB — **too tight** |

`halfvec`, not `vector`: half precision costs almost nothing in recall at these
dimensions and halves both the table and the index. **Recommendation: `halfvec(512)`
over the full catalog**, which fits with ~200 MB to spare. Start at 16k if you want
to see it working on day one, then widen — the real eval answers skew obscure enough
that the full catalog is worth the space.

### Enrichment cost

One-off, and it is the only real spend. Using the Batch API (50% off) with Haiku 4.5
at $1/$5 per MTok, ~600 input and ~200 output tokens per game:

| Scope | Model | Cost |
|---|---|---:|
| 16k rated games | Haiku 4.5 (batch) | **~$13** |
| 89k full catalog | Haiku 4.5 (batch) | **~$71** |
| 16k rated games | Sonnet 5 (batch) | ~$26 |

Worth spending the extra $13 on Sonnet 5 for the 16k that matter most and using
Haiku for the long tail — the popular games are the ones users will actually
describe, and enrichment quality is the whole feature.

### Per-search cost and latency

| Stage | Latency | Cost |
|---|---|---|
| LLM name + HyDE (Haiku 4.5) | 400–900 ms | ~$0.001 |
| Embed query (`voyage-4-lite`) | 100–200 ms | free tier |
| pgvector HNSW over 89k | <20 ms | — |
| Rerank 50 (`rerank-3-lite`) | 200–400 ms | free tier |
| **Total** | **~0.8–1.5 s** | **~$0.001** |

Supabase edge functions allow **150 s wall clock** on free and **2 s CPU**, where CPU
excludes time awaiting I/O — so a function that makes two external calls and a
database query is comfortably inside the limits. Memory is 256 MB.

A second of latency is acceptable here *if the UI admits it*. This is a "help me
remember" interaction, not a typeahead. Run the existing instant trigram search
underneath and show its results immediately, with the vague-search results arriving
a beat later — the fast path already exists and costs nothing to keep.

---

## 8. Suggested build order

Nineteen days to 30 Sep. Ordered so each step ships something demonstrable and
nothing is wasted if the next step is cut.

1. ~~**Widen the seed** (§5).~~ **DONE 15 Sep.** Greenlit by Josh the same day and
   shipped as pass 3 of `scripts/seed-games.ts` (`seedRereleasePageQuery`), proved
   against live IGDB by `npm run verify:seed-widening` before the re-seed ran, then
   re-seeded from zero. **The catalog went 89,123 -> 91,806**, pass 3 contributing
   exactly the 2,043 rows §5 predicted. `Resident Evil 2` is now two rows (1998 and
   2019), and `Persona 5 Royal`, `The Last of Us Part I`, `Mario Kart 8 Deluxe` and
   `Dark Souls: Remastered` are in the catalog for the first time. Share matching was
   re-measured after the re-seed and did not move: 19/21 confident, the same two
   misses.

   **One thing §5 understated.** The duplicate titles are not all pairs: there are
   **five** rows titled `Resident Evil` and four titled `Resident Evil 4`. The 21-link
   share measurement now returns four candidates reading exactly `Resident Evil` for
   one link, which is unpickable if the confirm screen renders a bare title. The
   ranking still puts the right one first and every candidate already carries
   `releaseDate` and cover art, so this is a display fix in the app -- written up in
   `technical-notes-for-sola.md` §11 -- but it is a real consequence and it was not
   predicted here.
2. ~~**Store the descriptive fields we already fetch and throw away.**~~ **DONE
   15 Sep**, and it needed no code: `mapping.ts` had written all five columns since
   11 Sep, and the only reason they were null on all 89,123 rows was that no seed had
   run from zero since. The re-seed above did it. **`summary` is now on 89,202 of
   91,806 rows, `themes` on 62,921, `keywords` on 49,399** -- all three were 0.
3. **LLM-names-the-game, grounded through `shelf_search_games`.** One edge function,
   no new infrastructure, no embeddings, no enrichment. **This alone will answer both
   of Josh's example queries.** One to two days, and it is the demo.
4. **Steam tag backfill** for the 7,635 mapped games. Two hours of polling, one
   afternoon of code.
5. **Enrichment + embeddings + HyDE.** The real recall engine, and where the long
   tail gets found. Three to four days.
6. **Reranker.** Half a day, measurable quality jump.

If the deadline bites, **steps 1–3 are a shippable feature** and a good demo. Steps
5–6 are what make it hold up under judging when someone types something obscure.

---

## 9. How to know it works

The eval harness built during this research is the deliverable that matters most,
because it is what stops this shipping half-baked.

**Artefacts** (in the session scratchpad, worth moving into the repo):

- `vibe-eval.tsv` — 38 authored queries. **Use with suspicion**: it scored 13
  points higher than reality.
- `reddit-eval.tsv` — 77 real queries harvested from r/tipofmyjoystick with answers
  confirmed by the subreddit's own solved-flair. Nobody on the team wrote these.
  **This is the one to hill-climb against.**
- `search_lab_docs` — a scratch table in the live project holding the 7,250-game
  corpus with IGDB text, Steam tags and hand-written enrichment, plus
  `shelf_lab_search()`. Drop with
  `drop table if exists search_lab_docs cascade;` when done.

**The harvest method is worth keeping.** r/tipofmyjoystick sets a post's flair to the
game's name once solved, so the answer key is free — no comment scraping. 1,598
solved posts were collected in a few minutes through the browser.

**One caveat to hold on to.** That subreddit skews to obscure childhood games —
flash games, edutainment, shovelware. Of 990 solved posts, most answers are titles
no commercial catalog carries. Shelf's actual case ("a game they saw a day or two
ago") skews recent and popular, which is *much* easier. So treat
`reddit-eval.tsv` as a **hard lower bound**: whatever it scores, the real feature
will do better. It is still the right thing to optimise, because it cannot be gamed.

**Targets, given lexical baseline is 0% / 2%:**

| Milestone | recall@5 on `reddit-eval.tsv` |
|---|---|
| lexical baseline (measured) | 2% |
| LLM-names-the-game alone | expect 40–60% |
| + enrichment embeddings + HyDE | expect 70–85% |
| + reranker | expect 80–90% |

Those three expectations are **predictions, not measurements** — they need an API
key to confirm (§10). Everything else in this document is measured.

---

## 10. What I need from you

Two things, both small:

1. **A Voyage AI API key** — <https://dashboard.voyageai.com>. Free tier is 200M
   tokens/month, which covers this entire project with room to spare. Without it I
   cannot measure the numbers in §9, only predict them.
2. **An Anthropic API key** with Batch API access, for enrichment and the
   query-understanding call.

With those two I can run the real experiment end to end — enrich a few thousand
games, embed them, and give you a measured recall number on the reddit set instead
of a predicted one — in a few hours rather than days.

Nothing else is blocked. IGDB credentials, the Supabase project, `pgvector`, the
corpus and both eval sets are all in place.

---

## Appendix — for Paul's cover-art question

The brief was search, so this is not a full investigation, but Paul's question has a
cheap measured answer and one correction that matters before design commits to
anything.

IGDB serves covers from a template URL with a swappable size segment, and `igdb.ts`
already builds these from the stored `cover.image_id`. **87,652 of 89,123 catalog
games have a cover (98.4%).** Measured by downloading the real images on
11 Sep 2026:

| Size segment | Actual pixels | Ratio |
|---|---|---|
| `t_thumb` | 90×90 | 1.000 (square, but a tiny crop) |
| `t_cover_big` | 264×352 | 0.750 |
| `t_cover_big_2x` (what we serve) | 528×704 | 0.750 |
| `t_720p` | 540×720 | 0.750 |
| `t_1080p` | 810×1080 | 0.750 |

**Correction: `igdb.ts:219` says `t_cover_big` is 264×374. It is 264×352.** The
difference is ratio 0.706 vs 0.750 — enough that frames designed to the documented
number would letterbox every cover in the app. The comment appears to repeat IGDB's
published figure rather than the served image.

Sampling the 15 most-rated games, **14 of 15 are exactly 0.750** and the odd one out
(0.671) is a small source image IGDB does not upscale. So **portrait is a reliable
3:4**, and Paul can design to that.

**There is no square cover to fetch from IGDB.** It stores one portrait cover per
game. `t_thumb`'s 90×90 is a centre crop, too small to use, and it crops exactly the
title text Paul is worried about.

### Steam has the thing Paul actually needs, and it is not a second ratio

Paul's stated problem is *"if we use one in a frame for the other the name may be
cropped out"*, and his reference is Netflix. Netflix does not solve that with two
art ratios — it composites a **transparent wordmark logo** over artwork cropped to
whatever the frame needs. Steam publishes exactly that asset.

Measured 11 Sep against `shared.steamstatic.com/store_item_assets/steam/apps/<appid>/`:

| Asset | Pixels | Ratio | Present in a 250-game sample |
|---|---|---|---:|
| `header.jpg` | 460×215 | 2.140 | **100%** |
| `capsule_616x353.jpg` | 616×353 | 1.745 | 92% |
| `library_600x900.jpg` | 300×450 | 0.667 | 91% |
| **`logo.png`** | ~640×360 | varies | **90%** |
| `library_hero.jpg` | 1920×620 | 3.097 | not sampled |
| all four of the above | | | 86% |

`logo.png` is **RGBA with genuine alpha** — verified by decoding the PNG, corner
alpha 0. It is the game's wordmark on transparency. With it, the two-ratio problem
dissolves: crop the key art to any shape the design wants and lay the logo on top,
and the name is never cropped because the name is a separate layer.

**Three caveats, and the first is the serious one.**

1. **Steam covers only 50.7% of rated games**, and misses precisely the ones Paul
   would care about — no Mario, no Zelda, no Ghost of Tsushima, no PlayStation
   exclusives. Combined with the 90% asset rate, `logo.png` reaches roughly **46% of
   rated games**. Paul said "most of the popular games at least", so a curated
   subset may be acceptable — but it cannot be the only source.
2. **Steam's portrait is 2:3 (0.667); IGDB's is 3:4 (0.750).** Mixing the two
   sources gives visibly non-uniform portrait tiles. Pick one as canonical and crop
   the other to match.
3. Steam's terms govern reuse of these assets. Worth a look before shipping them in
   a store build; this is a question for Josh, not an engineering one.

**What the backend can commit to today:** portrait 3:4 at 528×704 for 98.4% of the
catalog from IGDB, plus landscape art and a transparent wordmark for roughly half of
the popular ones from Steam. A genuine square crop with a legible name, for
everything, does not exist in any free source and would have to be produced.
