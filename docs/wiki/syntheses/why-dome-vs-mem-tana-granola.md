---
type: synthesis
tags:
  - positioning
created: 2026-05-25
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
description: "Positions Dome against Mem, Tana, Granola, Obsidian, etc.: invariant-enforcing compiled memory that mounts under existing tools."
status: draft
---

# Why Dome vs. Mem / Tana / Granola / others

The personal knowledge management space is crowded. Dome's existence is justified only if it does something the existing tools don't. This synthesis names the differentiator against each category.

## The landscape, in one table

| Tool / Category | What it optimizes | What it doesn't |
|---|---|---|
| **Wispr Flow** | Voice → text everywhere. Input layer. | No memory; doesn't compile knowledge. |
| **Granola** | AI meeting notes. Transcript + cleanup + chat over context. | Meeting-centric; doesn't model people / projects / strategy across time. |
| **Tana** | AI meeting + voice + structured graph via supertags. | Knowledge worker workspace, not personal memory substrate. Heavy ontology upfront. |
| **Mem** | Voice + meeting + clip capture; AI-organized. | App-centric; rigid structure; not Obsidian-compatible. |
| **Reflect** | Voice + Whisper + AI writing. | Note-taking-as-writing-tool; not a compiled memory layer. |
| **Fabric** | Personal AI over projects + memories + files. | New walled garden; data lives in Fabric's stores. |
| **Capacities** | Object-based notes (entities as first-class). | Demands user-built ontology; high upfront cost. |
| **Limitless / Plaud / Bee** | Always-on / wearable recording. | Privacy / consent / legal nightmare; not the right v0 wedge. |
| **EEON** | Voice → personal wiki. Most adjacent. | Closed source; vendor lock-in; not invariant-enforcing. |
| **ChatGPT Deep Research / NotebookLM** | Research → memo, with citations. | Research is one-shot; doesn't update durable personal memory. |
| **Obsidian / Notion / Roam** | User-built knowledge base. Powerful but DIY. | No AI maintainer; the user IS the maintainer; abandonment is common. |

## What Dome adds that none of the above have

1. **Invariant-enforcing tool layer that mounts under existing tools.** Dome doesn't compete with Claude Code or Obsidian; it makes them work together correctly. The vault stays in any markdown editor; the AI gains structural discipline at the Tool boundary.
2. **A compiled memory layer that grows with you.** Karpathy's LLM Wiki pattern, productized. Raw sources stay; the wiki compiles itself; trust is structural via invariants (see [[wiki/specs/sdk-surface]] §"Why this design").
3. **Interface-agnostic from day one.** Any MCP-capable harness becomes Dome-aware. Voice / mobile / web later sit on the same SDK contract. No lock-in to one chat product.
4. **Local-first, user-owned, portable.** The vault is plain markdown; git-backed; works in any editor; survives any tool's death.
5. **Generalizes beyond personal notes.** This very vault is a Dome instance — Dome on Dome. The pattern works for software design substrate, research bibliographies, character notes for fiction, family histories, etc. Not just managers, not just knowledge workers.

## What Dome gives up

- **Polished proprietary UI.** v0.5 ships none. Users live in their existing tools. v1+ adds native mobile / web / voice but the SDK is always the contract beneath.
- **Auto-categorization theater.** Dome's structure comes from what you talk about; it doesn't invent an ontology for you. The user with no vault gets one bootstrap from `dome init`; the user with an existing markdown vault gets `dome migrate`.
- **Always-on listening.** Capture is intentional. The privacy / consent / legal risks of always-on are not worth the wedge.

## Where this leads

Dome's wedge is *high-context operators* — managers, founders, researchers, consultants, technical leaders — who already feel fragmented AI context across pinned threads. The constraint that makes Dome work for them (the AI does the maintenance; the user just talks) is the same constraint that makes it work for anyone. Generality is structural; the wedge is sequencing.

## See also

- [[VISION]] (vault-root)
- [[wiki/concepts/brain-companion]]
- [[wiki/syntheses/v0.5-build-plan]]
- [[raw/original-architecture]]
