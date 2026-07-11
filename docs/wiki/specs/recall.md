---
type: spec
created: 2026-07-09
updated: 2026-07-09
sources:
  - "[[cohesive/reviews/2026-07-09-first-principles-product-review]]"
  - "[[wiki/specs/projection-store]]"
  - "[[wiki/specs/sdk-surface]]"
description: "Natural-language recall contract: shared lexical query analysis, bounded minimum-match FTS candidates, projection-memory coherence, and outcome canaries."
status: stable
---

# Recall

Recall turns a natural-language question into a bounded, source-backed working
set. Callers state the question; they do not choose FTS operators or decide how
many words must match.

This spec covers the shipped lexical candidate seam. Semantic embeddings,
answer synthesis, temporal reranking, and a richer moment/scope interface are
future channels that must earn their place through the same outcome cases.

## Interface

The existing interface stays small:

```ts
projection.searchDocuments({ query, category?, type?, limit? })
```

`Vault.query`, `dome.search.query`, `dome.search.export-context`, the built-in
agent's plugin-generic `run_view`, CLI, MCP, and HTTP all reach this seam. The
implementation owns natural-language query analysis.

## Lexical candidate contract

`src/recall/query-analysis.ts` performs one deterministic analysis:

1. lowercase and tokenize the question;
2. deduplicate terms;
3. remove grammatical stopwords;
4. remove answer-shape words such as `latest`, `outcome`, `status`, `open`, and
   `threads` when evidence-bearing terms remain;
5. bound the analyzed query to eight terms;
6. compile one FTS5 minimum-match expression.

One- and two-term focused queries remain conjunctive. Longer natural questions
require at least two significant terms, growing gradually to 40% for longer
queries. This prevents an intent word from vetoing an obvious page while also
preventing one generic overlap from flooding the candidate set.

Intent-word removal is conditional. A direct query such as `open threads`
keeps both words because removing them would leave no query.

The same analyzer powers projection-memory matching for open loops, decisions,
questions, and diagnostics. FTS and non-FTS recall therefore no longer disagree
about whether every word in a natural question must appear.

## Ranking remains downstream

Candidate generation maximizes bounded recall; it does not decide the final
working set. The `dome.search` view processors still own:

- best-section-per-page deduplication;
- projection-signal and graph expansion;
- reciprocal-rank fusion;
- page-type, claim, question, and diagnostic signals;
- superseded-page downranking;
- human-change recency decay;
- final result budgets and SourceRef scope.

Embeddings, when added, are another candidate channel before this ranking
layer—not a replacement for correct lexical behavior.

## Outcome tests

Recall changes must be tested at the interface in two layers:

- `tests/recall/lexical-recall-outcomes.test.ts` holds fast, work-derived
  recall@5 canaries and negative-noise cases;
- `tests/harness/scenarios/cli-surface/natural-language-recall.scenario.test.ts`
  proves the same natural question reaches its target through both `query` and
  `export-context` over the real adoption/projection/view path.

Cases should describe user questions and expected target pages. Tests should
not assert the generated FTS string except in the query-analysis unit tests.

## Related

- [[wiki/specs/projection-store]] §"fts_documents (FTS5)"
- [[wiki/specs/processors]] — `dome.search` processors
- [[wiki/specs/cli]] §"dome query"
- [[wiki/specs/agent-host]] — foreground agents consume recall through views
