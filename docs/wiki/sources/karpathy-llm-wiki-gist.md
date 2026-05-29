---
type: source
created: 2026-05-27
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"]
url: "https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f"
author: "Andrej Karpathy"
external: true
---

# Karpathy LLM Wiki gist

The gist that named and described the LLM Wiki pattern Dome productizes. Authored by [[wiki/entities/andrej-karpathy]].

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
- ✓ LLM-maintained wiki layer (garden-LLM processors per [[wiki/specs/processors]] §"Garden phase").
- ✓ Prompt as contract — garden-LLM processors carry their prompts alongside the processor source at `assets/extensions/<bundle>/processors/<name>.prompt.md`.
- △ Index + log as canonical files — Dome preserves these as optional/planned markdown projections. The shipped v1 path currently relies on adopted refs, the run ledger, projections, and search first; `dome.index` and `dome.log` are planned only if humans actually need those files.
- △ Operations: ingest, query, lint — query ships through `dome.search`; lint has a minimal `dome.lint` view processor; richer intake and lint/report flows remain on the v1 roadmap.

Some are revised:

- ✗ Karpathy's pattern uses one generic page schema; Dome lives with multiple page types per [[wiki/specs/page-schema]] (four defaults — entity / concept / source / synthesis — plus extension-contributed types). The type is derived from the `wiki/<plural>/` directory; the `dome.markdown` adoption-phase processor emits FactEffects naming the type and DiagnosticEffects on schema violations.
- △ Karpathy proposes atomic ideas as intermediate representation; Dome v1 doesn't materialize atoms on disk (deferred to v1.x+ if "what have I changed my mind about" queries become important).
- ✓ Structural enforcement of invariants (a Dome addition; Karpathy's pattern relies on prompt discipline). The engine's capability broker, fixed-point adoption loop, and AC3 lockstep convention together enforce what Karpathy's pattern relied on prompts to maintain.

## Why this source matters

It's the closest pre-existing description of Dome's compilation pattern. Citing it makes Dome's lineage visible and credits the prior art. The gist is short, technical, and durable — a good external reference for anyone trying to understand Dome's architecture.

## See also

- [[wiki/entities/andrej-karpathy]]
- [[wiki/concepts/llm-wiki-pattern]]
- [[wiki/specs/sdk-surface]] §"The four concepts"
