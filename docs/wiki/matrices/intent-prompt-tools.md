---
type: matrix
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# User intent × Prompt × Tools matrix

Maps user intents (what the human says they want) to the workflow prompt that loads and the Tool subset bound to the harness during that workflow. The matrix is the canonical reference for "what does the agent do when the user says X."

A workflow is invoked in three contexts (see [[wiki/specs/prompts-and-workflows]] §"Workflow invocation"): by an intake hook, by user intent in conversational mode, or by explicit name. This matrix focuses on the user-intent dimension; intake-triggered and named invocations are listed for completeness.

## Matrix

Each workflow declares which subset of the SDK's Tool catalog it binds. Opt-in workflows appear only in vaults that activate them.

| User intent (conversational mode) | Workflow prompt | Tier | Tools bound | Common Effects |
|---|---|---|---|---|
| "Capture this thought" / "Note that..." / "Remember that..." | `ingest` | default | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` | 5-15 page touches per call; new entities/concepts when justified by recurrence; `auto-update-index` hook fires for each wiki write |
| "What do I think about X?" / "What do I know about Y?" / "Ask my memory: ..." | `query` | default | `readDocument`, `searchIndex`, `wikilinkResolve`, `writeDocument` (only if user accepts synthesis-page creation) | Citations to pages and sources; optional synthesis page proposal |
| "Prep me for my meeting with Z" / "Brief me on T" | `query` (prep-mode framing) | default | `readDocument`, `searchIndex`, `wikilinkResolve` | Prep summary; no writes |
| "Check the wiki for issues" / "Lint my vault" / "What's stale?" | `lint` | default | `readDocument`, `searchIndex`, `wikilinkResolve`, `writeDocument` (proposing fixes to `inbox/review/` if sensitivity is enabled, or returning a structured report otherwise), `appendLog` | Proposed fixes; nothing applied without user confirmation |
| "Convert this Obsidian vault to Dome" | `migrate` | default | `readDocument`, `writeDocument`, `moveDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` | Detects existing structure; proposes migration plan to `.dome/migration-plan.md`; applies on `--apply` |
| "Give me a context packet for X" / "Export for ChatGPT" | `export-context` | default | `readDocument`, `searchIndex`, `wikilinkResolve` | Markdown blob to stdout or file; no vault mutations |
| "Research X and update my notes" | `research` | opt-in | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` (the research workflow makes external HTTP calls inside the prompt; no dedicated research Tool) | New `wiki/sources/` page; proposed updates to related concept / entity pages |
| (Voice-source file write to `inbox/voice/`) | `voice-ingest` (intake-triggered) | opt-in | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` (transcript cleanup runs inside the workflow prompt) | Same as ingest, plus cleanup of transcription artifacts |
| (Sensitive-flagged content during ingest) | `sensitivity-classify` (sub-workflow or pre-write hook) | opt-in | `readDocument`, `writeDocument` (target is `inbox/review/<file>.md`), `appendLog` | Item in `inbox/review/` with classification rationale |
| (Clip-source file write to `inbox/clip/`) | `clip-integrate` (intake-triggered) | opt-in | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` | Web-clip summarized; new source page; cross-references to related concepts |

## How intent → workflow happens

In conversational harnesses (Claude Code), the SDK's `system-base.md` system prompt is loaded at session start. It instructs the harness to identify the user's intent and route to one of the named workflows by loading its prompt (which then narrows the bound Tool subset).

The intent-routing logic itself is in the system prompt — not in the SDK. Specifically:

- The system prompt enumerates the workflow names and their triggers.
- When the user says something matching a trigger pattern, the system prompt instructs the harness to switch into that workflow's prompt for the duration of the next action.
- Multi-action conversations may cross workflows: "tell me what I know about Atlas, then capture this new concern" routes the first half to `query` and the second to `ingest`.

This pattern keeps Tools mechanical and intent-routing semantic.

## Why a fixed workflow set and not full freeform tool access

A workflow's tool subset is what makes behavior bounded. Without workflows, a harness with the full Tool catalog available could do anything in response to anything — a query intent might silently update pages, a capture intent might do research. Workflows narrow the action space to match the user's stated intent, and the bound Tool subset is the structural enforcement of that narrowing.

This is the same pattern Anthropic's Claude Code uses internally (different tool subsets for different modes) and the same pattern any well-designed agentic system uses.

## Plugin / vault-extension workflows

Plugins and vault-local prompts can register additional workflows; they declare their own (name, tools, triggers) and the matrix expands. Run `dome doctor --show workflows` for the resolved matrix at any time.

## Related

- [[wiki/specs/prompts-and-workflows]]
- [[wiki/specs/sdk-surface]] §"Tool catalog"
- [[wiki/matrices/tool-invariant-enforcement]]
- [[wiki/specs/sdk-surface]] §"Why this design" (the prompts-as-contract principle)
