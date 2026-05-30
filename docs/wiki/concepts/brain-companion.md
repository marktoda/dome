---
type: concept
tags:
  - product-framing
created: 2026-05-27
updated: 2026-05-29
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
status: stable
---

# Brain companion

Dome's product framing. A *brain companion* is ambient, always accessible, streamlined to talk to, allergic to ungrounded confidence, and patient enough to be useful in six months, in four years, in twenty.

The framing distinguishes Dome from adjacent product categories:

- Not a *notes app* (centers capture; ignores compilation).
- Not a *chatbot* (centers reply; ignores persistence).
- Not a *knowledge base* (centers structure; ignores fluidity).
- Not an *assistant* (centers task delegation; ignores reflective thought).

A companion is none of these — it's a long-running relationship with your own thinking, maintained by an AI that does the structural work so you stay free to think.

## What this implies for Dome's design

- **Ambient.** Accessible wherever the user is. On the desktop, an agentic harness (Claude Code today) arrives oriented to the vault via `CLAUDE.md`/`AGENTS.md`, and shipped named operations run through the CLI: `dome serve` / `dome sync` drive the compiler, `dome status` / `dome check` / `dome resolve` handle attention, and optional views such as `dome query`, `dome export-context`, `dome today`, `dome prep`, and `dome agenda` read adopted state when explicitly useful. Advanced `inspect`, `doctor`, `lint`, and `answer` commands remain for debugging and compatibility. On the phone (v2+), a native Dome surface provides voice capture and recall flows. The compiler host (`dome serve`) can run foreground or background; the vault stays coherent regardless of which surface is being used. See [[VISION]] §"Two surface patterns" and [[wiki/specs/harnesses]].
- **Always accessible.** The vault is local-first markdown; no cloud lock-in; no auth wall on day-to-day use. See [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]].
- **Streamlined to talk to.** Quick-capture is intended to be a file write to `inbox/raw/`: no app to launch, no form to fill. The `dome.intake` garden processors now compile raw captures into generated pages, route low-confidence extracted items through `dome resolve`, write source-backed capture syntheses and a recent-capture rollup, and warn when inbox files linger; richer long-horizon synthesis remains roadmap work. See [[wiki/specs/processors]] §"First-party processors" and [[wiki/matrices/intent-prompt-processors]].
- **Allergic to ungrounded confidence.** Every FactEffect carries a SourceRef pointing into an adopted commit (per [[wiki/specs/effects]] §"The SourceRef type"); contradictions surface as DiagnosticEffects; the user always wins (see [[VISION]] §"Principles" #5).
- **Patient enough to be useful over years.** The vault is portable markdown that outlives any individual tool. See [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]].

## See also

- [[wiki/concepts/llm-wiki-pattern]]
- [[wiki/specs/sdk-surface]] §"The four concepts"
- [[wiki/syntheses/why-dome-vs-mem-tana-granola]]
- [[VISION]] (vault-root)
