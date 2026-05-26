---
type: concept
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
status: stable
tags: ["product-framing"]
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

- **Ambient.** Accessible wherever the user is. On the desktop, an agentic harness (Claude Code today) arrives oriented to the vault via auto-loaded `AGENTS.md`, and any structured operation runs through the CLI (`dome lint`, `dome stats`, `dome lint --apply <id>`, `dome export-context`) — no new app to open. On the phone (v1+), a native Dome surface provides voice capture and recall flows. The compiler daemon (`dome serve`) runs continuously in the background; the vault stays coherent regardless of which surface is being used. See [[VISION]] §"Two surface patterns" and [[wiki/specs/harnesses]].
- **Always accessible.** The vault is local-first markdown; no cloud lock-in; no auth wall on day-to-day use. See [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]].
- **Streamlined to talk to.** Quick-capture is a file write to `inbox/raw/` (when activated). No app to launch; no form to fill. See [[wiki/specs/hooks]] §"Opt-in intake patterns."
- **Allergic to ungrounded confidence.** Every claim cites its source; contradictions are flagged; the user always wins (see [[VISION]] §"Principles" #5).
- **Patient enough to be useful over years.** The vault is portable markdown that outlives any individual tool. See [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]].

## See also

- [[wiki/concepts/llm-wiki-pattern]]
- [[wiki/specs/sdk-surface]] §"The four concepts"
- [[wiki/syntheses/why-dome-vs-mem-tana-granola]]
- [[VISION]] (vault-root)
