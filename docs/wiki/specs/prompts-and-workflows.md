---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]", "[[raw/original-architecture]]"]
---

# Prompts and workflows

This spec is normative for Dome's prompt library and the workflow pattern built on top of it. A workflow is *not* a separate concept; a workflow IS a prompt with frontmatter declaring the tools it expects and the triggers that invoke it. See §"Why this design" below for the prompts-as-contract architectural commitment behind this approach.

## A prompt is a markdown file

Every prompt lives as a markdown file in one of three sources (layered):

1. **SDK defaults** — shipped in the `@dome/sdk` package under `prompts/`.
2. **Plugin prompts** — bundled in installed plugins.
3. **Vault-local prompts** — `<vault>/.dome/prompts/*.md`. Override defaults by filename.

A prompt's body is the system / instruction text. If the prompt declares workflow frontmatter, it doubles as a workflow definition.

## Workflow frontmatter

A prompt is a *workflow* iff it carries workflow frontmatter:

```yaml
---
type: workflow-prompt
name: ingest
tools:
  - readDocument
  - writeDocument
  - appendLog
  - searchIndex
  - wikilinkResolve
triggers:
  - "intake:inbox/raw/*"
  - "intent:capture-thought"
description: "Process a new raw source: extract atoms, match to pages, propose updates, route sensitive, log."
---
```

Field semantics:

- `type: workflow-prompt` — distinguishes workflow prompts from system or partial prompts.
- `name` — the workflow's identifier. Hooks and CLI commands invoke workflows by name.
- `tools` — the tool subset available when this workflow runs. The harness binds *only* these tools when the workflow is loaded; others are unreachable. This is how the SDK constrains what an agent can do within a workflow.
- `triggers` — the events or intents that invoke this workflow. Format: `<source>:<pattern>`. Sources include `intake:` (matches a declarative hook's path pattern), `intent:` (matches a user-stated intent in conversational mode), `clock:` (matches a scheduled tick), `manual:` (only invoked by explicit name, e.g., `dome lint`).
- `description` — human-readable.

Prompts without workflow frontmatter are loaded by name and used as system prompts, prompt fragments, or composition partials.

## Shipped workflows by tier

The SDK ships these workflow prompts. Shipped-default workflows are loaded into every vault's prompt library; opt-in workflows are available but inert unless the vault activates them via a hook in `.dome/hooks/`.

| Workflow | Tier | Trigger | Tools available | Purpose |
|---|---|---|---|---|
| `ingest` | shipped default | `intake:inbox/raw/*` (when activated), `intent:capture-thought` | readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve | Process a raw source into wiki updates. |
| `query` | shipped default | `intent:ask` | readDocument, searchIndex, wikilinkResolve, writeDocument (synthesis-page proposal only) | Answer a question from the vault with citations. May propose synthesis page creation. |
| `lint` | shipped default | `manual:lint`, `clock:weekly` (when scheduled) | readDocument, searchIndex, wikilinkResolve, writeDocument, moveDocument, deleteDocument, appendLog | Detect drift: orphans, missing cross-refs, contradictions, schema violations. Propose first; apply on `--apply <id>` from the most recent report. |
| `migrate` | shipped default | `manual:migrate` | readDocument, writeDocument, moveDocument, deleteDocument, appendLog, searchIndex, wikilinkResolve | Convert an existing markdown vault to Dome shape. Plan first; apply on `--apply`. May delete superseded files. |
| `export-context` | shipped default | `manual:export-context` | readDocument, searchIndex, wikilinkResolve | Produce a markdown context-packet for cross-AI handoff. No vault mutations. |
| `research` | opt-in | `intake:inbox/research/*` (when activated), `intent:research` | readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve (HTTP fetch is done inside the workflow prompt) | Run external research; produce a source page under wiki/sources/; propose related page updates. |
| `voice-ingest` | opt-in | `intake:inbox/voice/*` (when activated) | same as `ingest`; transcript cleanup is in-prompt | Process a voice-transcript raw source. |
| `clip-integrate` | opt-in | `intake:inbox/clip/*` (when activated) | readDocument, writeDocument, appendLog, searchIndex, wikilinkResolve | Integrate a web clip: summarize, create a source page, propose cross-references. |

The workflow set is open: plugins and vault-local files register additional workflows. The table above enumerates what the SDK ships; vaults customize by overriding (e.g., `<vault>/.dome/prompts/ingest.md` replaces the default `ingest.md`).

## Composition (prompt partials)

A prompt may include another via a simple include directive:

```markdown
{{include: system-base.md}}

# Ingest workflow

You are ...
```

The include is resolved at load time against the same source-priority order (SDK → plugins → vault-local). This lets a vault override a base prompt without rewriting the whole workflow.

`system-base.md` is the SDK-shipped system prompt that describes the four-concept core, the invariants, and the wiki-maintainer ethos. Every workflow prompt starts with `{{include: system-base.md}}`. The SDK warns at workflow-load time if the include is absent.

## Vault augmentation slots

A workflow's system prompt is composed by `PromptLoader` from a stack of named **partials** (`.md` files), each filled either by the SDK or by a vault-local override at `<vault>/.dome/prompts/<name>.md`. Every shipped workflow prompt declares slots at well-defined positions that vaults may fill to add behavior *without* overriding the prompt wholesale. Slots silently resolve to empty when the named partial doesn't exist — opt-in by file creation, not by config.

### Slot catalog

| Slot name | Position | Scope | Filled by SDK by default? | Use it for |
|---|---|---|---|---|
| `preamble-vault-identity.md` | Top of `system-base.md` | **Every surface** that loads system-base — workflow runs AND MCP `instructions` / `dome.system_prompt` | ✅ Yes — uses `{{vault.path}}` | Naming the vault the LLM is operating on. Universal because both workflow runs and interactive MCP sessions need to know which vault is in scope. |
| `preamble-rendering-surface.md` | After `{{include: system-base.md}}` in each shipped workflow prompt | **Workflow runs only** (not MCP session orientation) | ✅ Yes | Telling the LLM its reply is the workflow's terminal output, not a chat turn. *Workflow-only on purpose*: MCP `instructions` is delivered to interactive Claude Code sessions, and "non-interactive single-turn" framing would mislead an interactive client. |
| `vault-prologue.md` | Bottom of `system-base.md` | Every surface that loads system-base | ❌ No — vault-fillable | Vault-wide vocabulary, naming conventions, cross-references the agent should always know |
| `<workflow-name>-augment.md` | After the workflow body's main behavior | One workflow | ❌ No — vault-fillable | Workflow-specific extensions — e.g., time-aware retrieval rules added to `query`, task-routing rules added to `ingest` |
| `<workflow-name>-epilogue.md` | End of the workflow prompt (final position) | One workflow | ❌ No — vault-fillable | Final-position reminders — gotchas, style notes, sensitivity rules the agent should re-encounter just before producing output |

All slots resolve via the same `{{include: <name>.md}}` directive. The SDK's "default-filled" preambles are partials in `src/prompts/builtin/`; vaults can override them by dropping a same-named file in `.dome/prompts/`.

### Why preambles use the slot model too

Before v0.5.1 the SDK injected vault identity and rendering-surface context via a code-driven `SYSTEM_PREAMBLES` registry in `agent-loop.ts`. That registry was retired and converted to the partial-based form so there is one unified composition model — the same mechanism vaults extend with is the one the SDK uses internally. The substrate scar that motivated the original code-driven approach (migrate.md's literal `<path>` masquerading as a variable) is preserved by **bounding the substitution surface explicitly**: only the closed set `{{vault.path}}` is recognized; other `<...>` or `{{...}}` patterns pass through as prose (see §"Template variables" below).

### Template variables

`PromptLoader` performs a single, well-bounded substitution pass after include resolution. The closed variable set:

| Variable | Substituted with | Notes |
|---|---|---|
| `{{vault.path}}` | `Vault.path` (the absolute filesystem path) | Used by `preamble-vault-identity.md` to name the vault; also available in vault-local partials |

Adding a new variable (e.g., `{{date.today}}`) is a deliberate substrate change — extend `PromptLoader.substituteVariables` and document the addition here. Unknown `{{...}}` patterns are left intact so reviewers (and a future `dome doctor` check) can flag typos like `{{vualt.path}}`.

### When to fill a slot vs. override the whole prompt

| Goal | Use |
|---|---|
| Add behavior to an existing workflow | Slot partial (`<workflow>-augment.md` or `<workflow>-epilogue.md`) |
| Add vault-wide context shared across every workflow | `vault-prologue.md` |
| Reshape how the LLM is told about the vault or rendering surface | Override `preamble-vault-identity.md` or `preamble-rendering-surface.md` |
| Replace the entire workflow's behavior | Override the workflow prompt itself (`<workflow>.md` — see §"Override layering" below) |

The slot partials are the additive surface; the filename-override mechanism is the escape hatch for deep changes. Most vault customization belongs in slots.

### Slot ordering in the resolved prompt

For any workflow `W`, the resolved system prompt looks like:

```
[preamble-vault-identity.md]      ← top of system-base.md (universal)
[system-base.md body — invariants, ethos]
[vault-prologue.md]               ← bottom of system-base.md (universal, vault-fillable)
[preamble-rendering-surface.md]   ← in each workflow.md, after the system-base include (workflow-only)

[workflow W's body — task-specific behavior]

[W-augment.md]                    ← after body
[W-epilogue.md]                   ← final position
```

For MCP-side surfaces that load system-base directly (`buildInstructions` for the `instructions` payload; `buildPromptAdapters` for `dome.system_prompt`), the resolved body stops at the `vault-prologue.md` line — `preamble-rendering-surface.md` is *not* included because those surfaces are interactive and the workflow-only framing would mislead the client.

Sections are separated by blank lines so the model sees clean markdown structure. Empty (unfilled) slots collapse without leaving artifacts.

## Override layering

When the same prompt filename exists in multiple sources, the vault-local version wins:

```
@dome/sdk/prompts/ingest.md         (SDK default)
node_modules/dome-plugin-x/prompts/ingest.md   (plugin)
<vault>/.dome/prompts/ingest.md     (vault-local — WINS)
```

Override is the escape hatch for deep changes that don't fit the augmentation-slot model. A manager's vault might override `ingest.md` to emphasize cross-pod entity awareness; a writer's vault might override it to emphasize character continuity tracking. The SDK ships sensible defaults; the user owns final behavior.

For most additive customization (vault-wide vocabulary, workflow-specific extensions), prefer §"Vault augmentation slots" above — slots compose with the SDK defaults rather than replacing them.

## Workflow invocation

A workflow is invoked in three contexts. **The CLI is the primary invocation surface in v0.5** — workflows are explicit operations the user (or an agent acting on the user's behalf) runs when wanted, not background concerns the agent must route through:

1. **By the CLI (primary)** — `dome lint` invokes the `lint` workflow; `dome export-context <topic>` invokes the `export-context` workflow; `dome migrate <path>` invokes `migrate`. CLI commands map 1:1 to workflows. Agentic harnesses invoke these via shell-execution (e.g., Claude Code's `Bash`); native Dome surfaces invoke them via their own UX affordances.
2. **By an intake hook (passive)** — a declarative hook's `workflow:` field names the workflow. The dispatcher loads the workflow prompt, binds the listed tools to the harness, hands the harness the document that triggered the intake, and runs. This is what makes `inbox/raw/`, `inbox/voice/`, `inbox/clip/` capture-and-compile work.
3. **By a user intent (optional, MCP-mounted harnesses)** — when a harness mounts the Dome MCP server, its `instructions` payload describes how to switch into a workflow prompt based on user intent. This is the MCP-prompt-switching mechanism; it's available for harnesses that benefit from it (see [[wiki/specs/mcp-surface]]) but not load-bearing for Claude Code in v0.5 — Claude Code uses its native conversation flow and shells out to the CLI when explicit workflow invocation is wanted.

In all three contexts, the workflow prompt's `tools:` field is the bound set. The harness cannot invoke tools outside that set during the workflow. This is the structural mechanism that prevents an `ingest` workflow from accidentally invoking `do-research`, or a `query` workflow from writing to a page when the user expected read-only behavior.

## Eval suite

Because the agent owns the page-write flow, prompt regressions are the biggest semantic risk. The SDK ships an eval suite as a `bun test --eval` target (not a `dome` CLI command — eval runs at test time, not as a runtime user action) that:

- Loads a fixture vault (separate from any real vault).
- Replays recorded conversations against named workflows.
- Asserts expected page touches (which pages were created / updated, which fields changed).
- Reports any divergence.

The eval suite is the structural mitigation for [[wiki/gotchas/agent-prompt-regression]]. Run it after every model upgrade, prompt edit, or before merging changes to `prompts/`.

## Why this design

This spec implements the **prompts-as-contract** principle — see [[wiki/specs/sdk-surface]] §"Why this design" for the canonical statement of the principle. Briefly: Dome's behavior lives in markdown prompts rather than TypeScript code, which makes behavior user-readable, user-editable, and able to evolve at the speed of language. The cost is prompt regression, mitigated by the eval suite (see [[wiki/gotchas/agent-prompt-regression]]).

What this spec adds beyond the principle: the *concrete shape* of how prompts double as workflows via frontmatter, the shipped workflows and their tool subsets (see §"Shipped workflows by tier"), the augmentation-slot model that lets vaults extend behavior additively (see §"Vault augmentation slots"), and the override layering for deep replacement.

### Two extensibility surfaces, not one

[[VISION]] §5 states that "Extensibility lives at the hook boundary." That remains true for *Tool-effect-driven* extensibility — behavior that reacts to a write, fires on a clock tick, or routes a dropped file. Prompts carry a *separate* extension surface: the augmentation slots in this spec. Hooks and slots are categorically different — hooks observe Effects and call Tools; slots compose the agent's instructions before the LLM runs. A vault that wants to "react when a wiki page is written" registers a hook; a vault that wants to "teach the agent about my daily-notes convention" fills an augmentation slot. Conflating them — e.g., a `workflow.loading.<name>` hook event with prompt-mutating handlers — would misuse the hook model, since prompt composition isn't an Effect.

Both surfaces leave the four-concept core (Vault, Document, Tool, Hook) untouched. Slots are layered on Hook's sibling concept — the Tool's prompt — through the existing `{{include: ...}}` primitive; no new core concept is introduced.

## Related

- [[wiki/specs/sdk-surface]] — Tool catalog (referenced from `tools:` field) and §"Why this design" for the prompts-as-contract principle.
- [[wiki/specs/hooks]] — hook system invokes workflows.
- [[wiki/gotchas/agent-prompt-regression]] — why eval suite matters.
- [[wiki/concepts/llm-wiki-pattern]] — origin of the prompt-as-contract pattern.
