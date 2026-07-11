# Natural-language lexical recall

**Date:** 2026-07-09
**Status:** complete
**Normative design:** [[wiki/specs/recall]]

## Objective

Eliminate the strict-all-token candidate-generation defect without adding a
new user surface or hiding it behind embeddings. Make query and context export
share one measured natural-language lexical contract.

## Implemented

- Added `src/recall/query-analysis.ts` as the single lexical analysis module.
- Replaced whitespace-quoted implicit-AND FTS construction with bounded
  significant-term minimum-match expressions.
- Applied the same semantics to projection-memory recall signals.
- Reused the analyzer for topic relevance instead of maintaining another
  stopword list.
- Added work-derived recall@5 and negative-noise canaries.
- Added an end-to-end scenario across both `dome query` and
  `dome export-context`.

## Deliberate non-goals

- No embeddings until lexical canaries and a larger benchmark establish the
  incremental value.
- No LLM reranker.
- No new top-level command or view category.
- No claim that this three-case canary set is the planned 30–50-case memory
  benchmark; it is the executable seed and regression fence for that suite.

## Completion criteria

- Natural questions with answer-shape words recover the target page at five.
- A document sharing only generic intent language is excluded.
- Focused two-term queries preserve conjunctive behavior.
- Query and export-context agree on the target through the real runtime.
- Typecheck and full tests pass.
