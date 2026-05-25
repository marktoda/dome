---
type: source
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]"]
url: "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
author: "Andrej Karpathy"
external: true
---

# Karpathy LLM Wiki gist

The gist that named and described the LLM Wiki pattern Dome productizes. Authored by [[wiki/entities/andrej-karpathy]] and referenced in `raw/original-architecture.md`.

## Key claims

- An LLM Wiki is a knowledge-base pattern where raw sources stay immutable; an LLM incrementally compiles them into a wiki layer of interlinked markdown pages.
- The directory structure and conventions should depend on the user/domain, not be fixed upfront.
- A `schema` document (the prompt) teaches the LLM how to maintain the wiki. The user can edit this to tune behavior.
- Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase.
- Common operations: ingest, query, lint. Lint catches contradictions, stale claims, orphan pages, missing cross-references.
- `index.md` is the content-oriented catalog; `log.md` is the chronological record.

## How Dome carries this forward

Most claims survive directly:

- ✓ Raw sources immutable ([[wiki/invariants/RAW_IS_IMMUTABLE]]).
- ✓ LLM-maintained wiki layer.
- ✓ Prompt as contract (see [[wiki/specs/sdk-surface]] §"Why this design").
- ✓ Index + log as canonical files.
- ✓ Operations: ingest, query, lint (+ research, capture, export-context, sensitivity-classify in Dome).

Some are revised:

- ✗ Karpathy's pattern uses one generic page schema; Dome lives with [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]] (four typed pages by directory).
- △ Karpathy proposes atomic ideas as intermediate representation; Dome v0.5 doesn't materialize atoms on disk (deferred to v1+ if "what have I changed my mind about" queries become important).
- ✓ Structural enforcement of invariants (a Dome addition; Karpathy's pattern relies on prompt discipline).

## Why this source matters

It's the closest pre-existing description of Dome's compilation pattern. Citing it makes Dome's lineage visible and credits the prior art. The gist is short, technical, and durable — a good external reference for anyone trying to understand Dome's architecture.

## See also

- [[wiki/entities/andrej-karpathy]]
- [[wiki/concepts/llm-wiki-pattern]]
- [[raw/original-architecture]]
