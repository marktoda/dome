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
  - readPage
  - writePage
  - appendLog
  - searchIndex
  - wikilinkResolve
  - routeSensitiveToInbox
  - updateIndex
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

## Shipped workflows (tier classification)

The SDK ships these workflow prompts. Tier-2 (shipped default) workflows are loaded into every vault's prompt library; tier-3 (opt-in) workflows are available but inert unless the vault activates them via a hook in `.dome/hooks/`.

| Workflow | Tier | Trigger | Tools available | Purpose |
|---|---|---|---|---|
| `ingest` | shipped default | `intake:inbox/raw/*` (when activated), `intent:capture-thought` | readPage, writePage, appendLog, searchIndex, wikilinkResolve | Process a raw source into wiki updates. |
| `query` | shipped default | `intent:ask` | readPage, searchIndex, wikilinkResolve, writePage (synthesis-page proposal only) | Answer a question from the vault with citations. May propose synthesis page creation. |
| `lint` | shipped default | `manual:lint`, `clock:weekly` (when scheduled) | readPage, searchIndex, wikilinkResolve, writePage (proposals to inbox/review or returned report), appendLog | Detect drift: orphans, missing cross-refs, contradictions, schema violations. Propose fixes. |
| `migrate` | shipped default | `manual:migrate` | readPage, writePage, moveDocument, appendLog, searchIndex, wikilinkResolve | Convert an existing markdown vault to Dome shape. Plan first; apply on `--apply`. |
| `export-context` | shipped default | `manual:export-context` | readPage, searchIndex, wikilinkResolve | Produce a markdown context-packet for cross-AI handoff. No vault mutations. |
| `research` | opt-in | `intake:inbox/research/*` (when activated), `intent:research` | readPage, writePage, appendLog, searchIndex, wikilinkResolve (HTTP fetch is done inside the workflow prompt) | Run external research; produce a source page under wiki/sources/; propose related page updates. |
| `voice-ingest` | opt-in | `intake:inbox/voice/*` (when activated) | same as `ingest`; transcript cleanup is in-prompt | Process a voice-transcript raw source. |
| `sensitivity-classify` | opt-in | sub-workflow inside `ingest` when `SENSITIVE_GOES_TO_INBOX` is enabled, or pre-write hook | readPage, writePage (target `inbox/review/`), appendLog | Classify content sensitivity; route to `inbox/review/` for items needing human review. |
| `clip-integrate` | opt-in | `intake:inbox/clip/*` (when activated) | readPage, writePage, appendLog, searchIndex, wikilinkResolve | Integrate a web clip: summarize, create a source page, propose cross-references. |

The workflow set is open: plugins and vault-local files register additional workflows. The nine above are what the SDK ships; vaults customize by overriding (e.g., `<vault>/.dome/prompts/ingest.md` replaces the default `ingest.md`).

## Composition (prompt partials)

A prompt may include another via a simple include directive:

```markdown
{{include: system-base.md}}

# Ingest workflow

You are ...
```

The include is resolved at load time against the same source-priority order (SDK → plugins → vault-local). This lets a vault override a base prompt without rewriting the whole workflow.

`system-base.md` is the SDK-shipped system prompt that describes the four-concept core, the invariants, and the wiki-maintainer ethos. Every workflow prompt should start with `{{include: system-base.md}}`.

## Override layering

When the same prompt filename exists in multiple sources, the vault-local version wins:

```
@dome/sdk/prompts/ingest.md         (SDK default)
node_modules/dome-plugin-x/prompts/ingest.md   (plugin)
<vault>/.dome/prompts/ingest.md     (vault-local — WINS)
```

This is what lets a user tune ingest behavior to their vault. A manager's vault might override `ingest.md` to emphasize cross-pod entity awareness; a writer's vault might override it to emphasize character continuity tracking. The SDK ships sensible defaults; the user owns final behavior.

## Workflow invocation

A workflow is invoked in three contexts:

1. **By an intake hook** — a declarative hook's `workflow:` field names the workflow. The dispatcher loads the workflow prompt, binds the listed tools to the harness, hands the harness the document that triggered the intake, and runs.
2. **By a user intent (in conversational mode)** — when a harness has a conversational session open, the system prompt instructs the harness to route the user's intent to a matching workflow's prompt. Switching workflows mid-session re-binds the tool set.
3. **By an explicit name** — `dome lint` invokes the `lint` workflow; `dome export-context <topic>` invokes the `export-context` workflow. CLI commands map 1:1 to workflows for the cases where workflow invocation is the entire user action.

In all three contexts, the workflow prompt's `tools:` field is the bound set. The harness cannot invoke tools outside that set during the workflow. This is the structural mechanism that prevents an `ingest` workflow from accidentally invoking `do-research`, or a `query` workflow from writing to a page when the user expected read-only behavior.

## Eval suite (proposed v0.5 surface)

Because the agent owns the page-write flow, prompt regressions are the biggest semantic risk. The SDK ships an `eval` command that:

- Loads a fixture vault (separate from any real vault).
- Replays recorded conversations against named workflows.
- Asserts expected page touches (which pages were created / updated, which fields changed).
- Reports any divergence.

The eval suite is the structural mitigation for [[wiki/gotchas/agent-prompt-regression]]. Run it after every model upgrade, prompt edit, or before merging changes to `prompts/`.

## Why this design

This spec implements the **prompts-as-contract** principle — see [[wiki/specs/sdk-surface]] §"Why this design" for the canonical statement of the principle. Briefly: Dome's behavior lives in markdown prompts rather than TypeScript code, which makes behavior user-readable, user-editable, and able to evolve at the speed of language. The cost is prompt regression, mitigated by the eval suite (see [[wiki/gotchas/agent-prompt-regression]]).

What this spec adds beyond the principle: the *concrete shape* of how prompts double as workflows via frontmatter, the seven shipped workflows and their tool subsets, and the override layering between SDK / plugin / vault-local prompts.

## Related

- [[wiki/specs/sdk-surface]] — Tool catalog (referenced from `tools:` field) and §"Why this design" for the prompts-as-contract principle.
- [[wiki/specs/hooks]] — hook system invokes workflows.
- [[wiki/gotchas/agent-prompt-regression]] — why eval suite matters.
- [[wiki/concepts/llm-wiki-pattern]] — origin of the prompt-as-contract pattern.
