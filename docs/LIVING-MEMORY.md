# Living Memory — decay, strengthening, association

How the hybrid-memory plugin behaves as a *living system*: memories strengthen when used, decay
when they aren't, bond when recalled together, carry the context they were formed under, and
consolidate when they express the same thought. This page documents the mechanics and every
config knob added by the living-memory upgrade (all **on by default** unless marked).

## Strengthens when recalled

- Every genuine full-content recall — ambient injection **and** explicit `memory_recall` — bumps
  `recall_count`/`access_count`, renews the decay TTL, and nudges **confidence asymptotically
  toward 0.95** (5% of the remaining gap per recall; 1.0 stays reserved for verified/confirmed).
  Time-travel reads (`asOf`) never count.
- **Hebbian bonding** (`graph.strengthenOnRecall`, default **true**): facts recalled *together*
  strengthen their `RELATED_TO` links (+0.1, top-8 co-recalled per recall). Recall shapes the graph.
- Recall also extends a fact's decay **half-life** (up to 3× — see below), so used memories age
  slower, not just later.

## Decays — as a curve, not a cliff

- **Confidence half-life** (`maintenance.decay.mode`, default `"half-life"`): confidence decays
  continuously per content-type half-life (`decision`/`preference`/`edict`: never; `handoff` 30d;
  `conversation`/`progress` 45d; `fact`/`note` 60d; `research` 90d; `project` 120d), extended by
  recall. Facts falling below 0.1 confidence are deleted. `"cliff"` restores the legacy one-shot
  halving as an escape hatch. `maintenance.decay.secondChance` (default true) gives important
  (≥0.7) or frequently-recalled (≥3) facts exactly **one** TTL/2 reprieve at expiry instead of
  deletion.
- **Link decay** (`graph.linkDecay { enabled: true, halfLifeDays: 30, floor: 0.05 }`): unused
  `RELATED_TO` links lose half their strength per half-life and are pruned below the floor — the
  counterpart that keeps Hebbian bonding from saturating every edge at 1.0. Typed/curated links
  (`PART_OF`, `CAUSED_BY`, …) never decay.
- **Pinned facts are exempt from all decay deletion**, and `durable` now means 180d (was 90d,
  indistinguishable from `normal`).

## Neighbors at formation

- **Universal auto-linking** (`graph.autoLink`, now default **true**; budget
  `graph.autoLinkBudgetPerMin: 30`): every newly stored fact — auto-capture, distill, reflection,
  consolidation, CLI, GraphQL, not just the `memory_store` tool — gets semantic + entity links
  asynchronously at formation. A fact without edges can never be found associatively.
- **Edges across time** (`graph.temporalEdges`, default true): consecutive facts of a session are
  chained with `PRECEDED_BY` links (strength 0.3), giving recall and the Memory Graph a temporal
  trail. Temporal edges neither strengthen nor decay.

## Associative recall

- **Auto-recall graph expansion** (`graphRetrieval.autoRecallExpand { enabled: true, maxAdds: 5 }`):
  after the ambient pipeline ranks its candidates, 1-hop neighbors of the top-3 seeds join the
  candidate set with hop-decayed scores — injected context includes what the memory *associates*
  with the topic, not just what embeds like the prompt. Association follows **strong meaning-edges
  only**: `PRECEDED_BY` hops and links below strength 0.4 are excluded (session adjacency is not
  relevance).
- Explicit `memory_recall` keeps its existing GraphRAG expansion; co-activation ranking (facts
  history recalls as a group boost each other) now computes from real `recall_events`
  co-occurrence when composite-score v2 is enabled.

## Same-thought consolidation

- Consolidation clusters by embedding cosine **and by claim**: facts with the same non-empty
  `(entity, key)` in the same scope merge even when phrasing lands below the 0.92 cosine
  threshold. Cadence raised from ~monthly to **every 5 days** (`consolidate` step) so similar
  facts merge before their TTL wins.

## Emotional state & routines

- **Affect stamping** (nightly `affect-stamp` step, active when `frustrationDetection.enabled`):
  the frustration detector's per-session signals stamp a confidence-weighted **valence** (−1..1)
  and `affect_source` onto facts formed in that session's window. Memory formation carries
  emotional state; nothing runs on the hot path.
- **Routine mining** (`maintenance.routineMining { enabled: true, maxPerRun: 2 }`, nightly): recall
  patterns recurring ≥3 times across ≥3 distinct weeks in the same weekday/time-band become
  ordinary decayable `routine` facts ("Routine: on Tuesday mornings, a recurring focus is …").
  Routines that stop recurring decay out — learned from interaction, not programmed.

## Free-text contradictions (shipped)

- **Contradiction candidates** (`maintenance.contradictions { freeText: true, similarityFloor:
  0.85, maxPairsPerRun: 40, minConfidence: 0.7 }`, nightly): the structured detector only sees
  exact entity+key collisions — this pass closes the free-text gap. Recent facts (48h) → vector
  top-k in-scope neighbors at cosine ≥0.85 → NLI verdict (nano tier, temperature 0) →
  `recordContradiction` with the `nli_free_text` audit marker and a `CONTRADICTS` link, flowing
  into the same nightly resolve pass and the Memory Graph conflicts panel. Near-duplicates
  (consolidation's job) and same-entity+key pairs (the structured detector's job) are excluded.

## Serendipity slot (shipped, staged OFF)

- **`autoRecall.serendipity`** (`{ enabled: false, cooldownPrompts: 10, minLinkStrength: 0.4,
  staleImportanceMin: 0.7, staleDays: 30 }`): when enabled, once per N prompts one labeled
  `[serendipity]` headline joins ambient injection — weighted-random from
  strong-but-never-recalled graph neighbors of the current results (falling back to
  stale-important facts). Index-only exposure: a 60-char title, never full text, recall_count
  untouched. The remaining named staged exception (prompt-visible); flip after a subjective trial.

## Staged (off by default — measured)

- **Composite-score v2 + MMR diversity** (`retrieval.compositeScore.v: 2`; `retrieval.diversity
  { enabled, mode: "mmr", mmrLambda: 0.7 }` — `mode`/`mmrLambda` now actually parse): the flip
  criterion (arm B ≥ arm A on both nDCG@10 and P@5) was **measured and failed** on the gold set
  — `armA(v1) nDCG@10=1.000 · armB(v2+mmr) nDCG@10=0.996`, equal P@5 — so both stay opt-in.
  Caveats recorded honestly: the fts5 fixture's ranking is already saturated (any reorder can
  only cost) and `applyMMR` runs on its bigram fallback until candidate vectors are threaded
  through. `tests/retrieval-ab-composite.test.ts` re-measures on every CI run and fails if v2
  ever regresses nDCG by >0.02; a richer gold set with real embeddings is the path to a flip.
- **Session-start briefing** (`autoRecall.retrievalDirectives.sessionStart`): when enabled, the
  briefing also resurfaces up to 3 stale-important memories (importance ≥0.7, untouched 30+ days).
  (Overnight research briefings deliver independently of this flag — see
  [PROACTIVE-RESEARCH.md](PROACTIVE-RESEARCH.md).)

## Measurement

`benchmark/retrieval-eval/` + `tests/retrieval-eval-harness.test.ts` pin retrieval quality
(P@5 / R@10 / nDCG@10 over a deterministic 200-fact fixture, plus an ambient-injection hit-rate
sample) as CI floors — ranking regressions fail CI. `tests/retrieval-ab-composite.test.ts` keeps
the v1-vs-v2+MMR comparison honest on every run. Decay behavior is pinned by fast-forward
survival tests in `tests/living-memory-dynamics.test.ts` (curve composition, pinned survival,
one-shot second chances, recall-extended half-lives).

## Built on top of this: the proactive research loop

The observation layer documented here (valence, routines, frustration signals, patterns) now
feeds an initiative loop — nightly insight synthesis → deterministic trigger → overnight web
research by a cron agent → morning briefing. See [PROACTIVE-RESEARCH.md](PROACTIVE-RESEARCH.md).
