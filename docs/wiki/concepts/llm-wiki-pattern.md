---
type: concept
description: "Karpathy's pattern of an LLM compiling immutable raw sources into a linked markdown wiki; Dome productizes it with enforced invariants."
created: 2026-05-27
updated: 2026-05-27
sources: ["[[wiki/sources/karpathy-llm-wiki-gist]]"]
status: stable
tags: ["inspiration", "architecture"]
---

# LLM Wiki pattern

A knowledge-management pattern in which an LLM agent maintains a structured markdown wiki by compiling immutable raw sources into a living, cross-referenced layer of synthesized pages. Coined by [[wiki/entities/andrej-karpathy]] in his "llm-wiki" gist.

## Core elements

1. **Raw sources** — immutable inputs (voice transcripts, meeting notes, web clips, papers, etc.) the user provides. The wiki cites raws; raws cite reality.
2. **Wiki layer** — synthesized markdown pages the LLM creates and updates over time. Pages are linked bidirectionally; structure emerges from what the user talks about.
3. **Index** — content-oriented catalog of pages, maintained automatically.
4. **Log** — chronological record of operations (ingest, query, lint, update).
5. **Schema / prompt** — the contract that teaches the LLM how to maintain the wiki. Behavior lives in prose, not code.

## Why this matters for Dome

Dome is the productization of this pattern with structural enforcement of the invariants the pattern relies on. Karpathy's framing solved Dome's biggest design question: don't build a knowledge graph database; build a compiler that turns raw input into structured markdown. See [[wiki/specs/sdk-surface]] §"The four concepts" for how the pattern maps onto Dome's primitives (Vault, Proposal, Processor, Effect).

## Notable departures Dome makes

- **One-page-schema → typed-by-directory.** Karpathy's pattern uses one generic page format; Dome lives with multiple page types declared in `<vault>/.dome/page-types.yaml` (four defaults — entity / concept / source / synthesis — plus extension-contributed types like daily / weekly from the `dome.daily` bundle). Page-type validation is a FactEffect (for the type derivation) and a DiagnosticEffect (for schema violations) emitted by the `dome.markdown` adoption-phase processor per [[wiki/specs/page-schema]] §"Universal frontmatter" and [[wiki/specs/processors]] §"First-party processors".
- **Wikilink-fullpath convention.** Karpathy's pattern allows short-form wikilinks (`[[Maya]]`); Dome's `dome.markdown.validate-wikilinks` adoption-phase processor emits a blocking DiagnosticEffect on short-form links, requiring the fullpath form (`[[wiki/entities/maya]]`) for unambiguous resolution. Pinned by the `dome.markdown` bundle's manifest declaration per [[wiki/matrices/built-in-extensions-x-phase]].
- **Atomic ideas not materialized in v1.** Karpathy's pattern allows atomic ideas as intermediate representation. Dome holds atoms in memory during garden-LLM processing, doesn't persist them. v1.x+ may add a `wiki/claims/` type if "what have I changed my mind about" queries become important.

## See also

- [[wiki/sources/karpathy-llm-wiki-gist]]
- [[wiki/specs/sdk-surface]] §"The four concepts"
- [[wiki/specs/processors]] §"First-party processors"
- [[wiki/concepts/brain-companion]]
