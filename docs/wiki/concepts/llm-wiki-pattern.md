---
type: concept
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[wiki/sources/karpathy-llm-wiki-gist]]"]
status: stable
tags: ["inspiration", "architecture"]
---

# LLM Wiki pattern

A knowledge-management pattern in which an LLM agent maintains a structured markdown wiki by compiling immutable raw sources into a living, cross-referenced layer of synthesized pages. Coined by [[wiki/entities/andrej-karpathy]] in his "llm-wiki" gist.

## Core elements

1. **Raw sources** — immutable inputs (voice transcripts, meeting notes, web clips, papers, etc.) the user provides. The wiki cites raws; raws cite reality.
2. **Wiki layer** — synthesized markdown pages the LLM creates and updates over time. Pages are linked bidirectionally; structure emerges from what the user talks about.
3. **Index** — content-oriented catalog of pages, maintained by the LLM.
4. **Log** — chronological record of operations (ingest, query, lint, update).
5. **Schema / prompt** — the contract that teaches the LLM how to maintain the wiki. Behavior lives in prose, not code.

## Why this matters for Dome

Dome is the productization of this pattern with structural enforcement of the invariants the pattern relies on. Karpathy's framing solved Dome's biggest design question: don't build a knowledge graph database; build a compiler that turns raw input into structured markdown. See [[wiki/specs/sdk-surface]] §"The four concepts" for how the pattern maps onto Dome's primitives.

## Notable departures Dome makes

- **One-page-schema → four-page-schema (typed by directory).** Karpathy's pattern uses one generic page format; Dome lives with four types (entity / concept / source / synthesis) because the user's actual vault evidenced four. See [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]].
- **Atomic ideas not materialized in v0.5.** Karpathy's pattern allows atomic ideas as intermediate representation. Dome holds atoms in memory during ingest, doesn't persist them. v1+ may add `wiki/claims/` if "what have I changed my mind about" queries become important.

## See also

- [[wiki/sources/karpathy-llm-wiki-gist]]
- [[wiki/specs/sdk-surface]] §"The four concepts"
- [[wiki/concepts/brain-companion]]
- [[wiki/specs/sdk-surface]] §"Why this design" (prompts as contract)
