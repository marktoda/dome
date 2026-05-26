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
| "Capture this thought" / "Note that..." / "Remember that..." | `ingest` (also intake-triggered via shipped-default `inbox/raw/`) | default | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` | 5-15 page touches per call; new entities/concepts when justified by recurrence; `auto-update-index` hook fires for each wiki write |
| "What do I think about X?" / "What do I know about Y?" / "Ask my memory: ..." | `query` | default | `readDocument`, `searchIndex`, `wikilinkResolve`, `writeDocument` (only if user accepts synthesis-page creation) | Citations to pages and sources; optional synthesis page proposal |
| "Prep me for my meeting with Z" / "Brief me on T" | `query` (prep-mode framing) | default | `readDocument`, `searchIndex`, `wikilinkResolve` | Prep summary; no writes |
| "Check the wiki for issues" / "Lint my vault" / "What's stale?" | `lint` | default | `readDocument`, `searchIndex`, `wikilinkResolve`, `writeDocument`, `moveDocument`, `deleteDocument`, `appendLog` | Proposed fixes by default (report under `inbox/review/lint-report-YYYY-MM-DD.md`); named findings applied on `--apply <id>` from the most recent report. Primary invocation: `dome lint` from any shell (Claude Code's `Bash`, terminal, etc.) |
| "Convert this Obsidian vault to Dome" | `migrate` | default | `readDocument`, `writeDocument`, `moveDocument`, `deleteDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` | Detects existing structure; proposes migration plan to `.dome/migration-plan.md`; applies on `--apply` (including any deletions of superseded files). Primary invocation: `dome migrate <path>` |
| "Give me a context packet for X" / "Export for ChatGPT" | `export-context` | default | `readDocument`, `searchIndex`, `wikilinkResolve` | Markdown blob to stdout or file; no vault mutations. Primary invocation: `dome export-context "<topic>"` |
| "Research X and update my notes" | `research` | opt-in | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` (the research workflow makes external HTTP calls inside the prompt; no dedicated research Tool) | New `wiki/sources/` page; proposed updates to related concept / entity pages |
| (Voice-source file write to `inbox/voice/`) | `voice-ingest` (intake-triggered) | opt-in | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` (transcript cleanup runs inside the workflow prompt) | Same as ingest, plus cleanup of transcription artifacts |
| (Clip-source file write to `inbox/clip/`) | `clip-integrate` (intake-triggered) | opt-in | `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve` | Web-clip summarized; new source page; cross-references to related concepts |

## How intent → workflow happens

**The primary path in v0.5 is the CLI.** When the user says "lint my vault," the conversational harness (or the user directly) invokes `dome lint` via shell. When the user says "export context for X," the invocation is `dome export-context "X"`. The intents in the table above name *what the user wants*; the workflow column names the prompt the CLI loads; the agent loop runs that prompt against the bound Tool subset.

For harnesses that mount the optional MCP server, an additional path exists: the SDK's `system-base.md` system prompt is loaded at session start (as the MCP `instructions` payload), and it instructs the harness to identify the user's intent and switch into a named workflow's prompt. This MCP-prompt-switching is available but not load-bearing in v0.5 — Claude Code's primary route is conversational reasoning + Bash-invoked CLI commands when explicit workflow invocation is wanted.

In either path:

- The system prompt enumerates the workflow names and their triggers.
- Switching into a workflow's prompt narrows the bound Tool subset to that workflow's declared tools.
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
