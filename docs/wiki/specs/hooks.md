---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Hooks

This spec is normative for Dome's Hook mechanism — the single extensibility surface for behavior. Hooks observe events derived from Tool Effects and may propose follow-on Tool calls. They never mutate the vault directly; see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]].

The hook mechanism subsumes several patterns that would otherwise look like separate primitives:

- **On-write reactions** (auto-update-index, auto-cross-reference, notify, sync).
- **Drop-zone intakes** (writes to `inbox/<bucket>/` trigger workflows). Not a separate concept; just a declarative hook with a path-pattern filter.
- **Periodic maintenance** (scheduled lint, periodic export). Scheduled hooks subscribe to events emitted by a clock source.

All of these are hooks. The framework does not need separate "intake" or "scheduler" abstractions.

## Event taxonomy

Every event Dome emits is derived from a Tool Effect or from an internal lifecycle source. Hooks subscribe via dotted-path patterns; most specific match wins; wildcards allowed. See [[wiki/matrices/event-types-and-payloads]] for the full taxonomy. The dispatcher projects Effects into events automatically — there is no `fireEvent` API.

## Registration forms

Hooks register via two equivalent forms.

### Programmatic — `.dome/hooks/*.ts`

```ts
import { registerHook } from "@dome/sdk";

registerHook("document.written.wiki.entity", async ({ path, diff }, ctx) => {
  // Read other entity pages, search for mentions of the new entity name,
  // and propose backlinks via ctx.tools.writePage(...).
});
```

The programmatic form supports arbitrary logic. The handler receives the event payload and a `ctx` object exposing the Vault's Tools (NOT the filesystem; see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]).

### Declarative — `.dome/hooks/*.yaml`

```yaml
event: document.written
path_pattern: "inbox/raw/*"     # optional filter on the path field
workflow: ingest                 # name of a prompt-with-workflow-frontmatter
async: true                      # optional; defaults to true
```

The declarative form is sugar for the common case: "when X happens, run workflow Y." The dispatcher reads the YAML, builds a handler that loads the named workflow's prompt + tool subset (see [[wiki/specs/prompts-and-workflows]]) and runs it against the harness-bound LLM.

The **drop-zone intake pattern** uses the declarative form exclusively. The principle: a user (or another process) writes a file to a known directory, the hook fires, the workflow processes the file. This generalizes "quick capture" without any dedicated CLI machinery — `dome capture` becomes a shell idiom (`echo "$THOUGHT" > $VAULT/inbox/raw/$(date -u +%Y%m%d-%H%M%S).md`) and the hook does the rest. New capture kinds = new buckets + new hook YAMLs.

## Shipped default hooks (tier 2 — enabled by default)

The SDK ships two hooks as shipped defaults — enabled in every vault unless explicitly disabled in `.dome/config.yaml`:

### `auto-update-index`

```yaml
# Shipped with the SDK; equivalent vault-local form
event: document.written.wiki.*
async: true
handler: builtin:auto-update-index
```

Subscribes to all wiki write effects (and `document.deleted.wiki.*`). The handler reads the modified Document, computes the index entry, and writes the updated `index.md` via `writePage(index.md, ...)`. The handler is idempotent and cycle-safe (the index write itself doesn't match `document.written.wiki.*` because index.md is not under `wiki/`).

### `auto-cross-reference`

```yaml
event: document.written.wiki.entity
async: true
handler: builtin:auto-cross-reference
```

Subscribes to new or updated entity-page writes. The handler searches the wiki for unlinked mentions of the entity's name and proposes adding `[[wiki/entities/<name>]]` backlinks via `writePage` against each candidate page. Updates are proposed, not silent: the agent surfaces them to the user when running in conversational mode, or queues them in `inbox/review/` if that destination is enabled.

Both shipped defaults can be disabled in `.dome/config.yaml`:

```yaml
hooks:
  builtin:
    auto-update-index: enabled
    auto-cross-reference: disabled    # for vaults that don't want auto-backlinking
```

## Opt-in intake patterns (tier 3 — not active by default)

The SDK ships hook *templates* for common intake patterns. These are NOT active in a fresh vault; the user enables them by writing the corresponding YAML to `.dome/hooks/` (typically via `dome init --kind <profile>` shortcuts; see [[wiki/specs/cli]]).

| Template name | Path pattern | Workflow invoked |
|---|---|---|
| `intake-raw` | `inbox/raw/*` | `ingest` |
| `intake-voice` | `inbox/voice/*` | `voice-ingest` |
| `intake-research` | `inbox/research/*` | `research` |
| `intake-clip` | `inbox/clip/*` | `clip-integrate` |
| `sensitivity-classify-on-ingest` | matches `document.written.inbox.raw` (after-ingest classification and routing) | `sensitivity-classify` |

Activation is manual in v0.5: copy the template YAML from the SDK's `hooks/templates/` directory into `<vault>/.dome/hooks/`, then create the `inbox/<bucket>/` directory the template listens on. A vault never has an `inbox/<bucket>/` it didn't explicitly create.

`dome init` does not pre-create any intake. The vault ships bare; users add what they need. Future "packs" or "presets" may layer one-command activation over this; v0.5 keeps the activation flow minimal.

### `inbox/review/` — opt-in sensitivity destination

`inbox/review/` is the destination for content the `sensitivity-classify` workflow flags as sensitive. It is NOT an intake (no workflow runs on writes to it). It is the user's manual-review queue. When the `SENSITIVE_GOES_TO_INBOX` invariant is enabled (see [[wiki/invariants/SENSITIVE_GOES_TO_INBOX]]) and a vault activates the `sensitivity-classify-on-ingest` hook template, content that's classified sensitive lands in `inbox/review/<filename>.md` via `writePage`. The user opens it in Obsidian or via `dome doctor --show review-queue` and resolves each item.

Vaults that don't enable sensitivity classification never have an `inbox/review/` directory.

## Execution model

- **Async by default.** When a Tool returns its Effects, the Hook dispatcher enqueues matching events to a background queue and the Tool returns to its caller immediately.
- **Sync opt-in.** A hook may declare `async: false` (declarative) or pass `{ sync: true }` to `registerHook` (programmatic). Sync hooks run inline before the Tool returns. Reserved for hooks that must complete before downstream code observes the result — e.g., a sensitivity-classifier that gates the write destination.
- **Queue backend.** v0.5 ships with an in-process queue (`p-queue` instance per Vault). The backend is swappable via configuration; Redis-backed BullMQ is a reasonable v1 swap.
- **Failure model.** A hook handler that throws is logged as a `hook-failure` entry in `log.md`. The originating Tool call is not affected. Three consecutive failures of the same handler trigger `hook-disabled`; the handler is quarantined until `dome doctor` is run.
- **Cycle prevention.** A causation chain depth limit (configurable, default 5) prevents infinite loops. See [[wiki/gotchas/hook-cycle]].

## Hook dispatch ordering

When multiple hooks match an event:

1. Sync hooks run first, in registration order.
2. Async hooks run on the background queue. Within a single event's dispatch, order is preserved; across events, the queue is not strictly FIFO.

Registration order: SDK defaults → installed plugins (dependency-tree order) → vault-local files (alphabetical filename).

## Why hooks are the only behavior-extension surface

Tools are the only mutation surface. Hooks are the only reaction surface. Every behavior extension Dome will ever need can be expressed as one or both:

- "Run X workflow on Y kind of input" → declarative hook on `document.written` with a path filter and a workflow name.
- "Notify me when Z happens" → programmatic hook on event Z calling an external notification.
- "Maintain a derived view of pages" → programmatic hook on `document.written.*` that updates an index page via `writePage`.
- "Schedule daily lint" → declarative hook on `clock.tick.daily` invoking the `lint` workflow.
- "Auto-cross-reference new entities" → the shipped `auto-cross-reference` hook (or your own variant).

If a feature can't be expressed as Tool registration + Hook registration, the four-concept core is missing something. The intent is to keep the core stable; new behavior surfaces should not appear.

## Why this design (the principle)

The hook system is what makes Dome stable as a substrate while flexible as a product. The four-concept core (Vault, Document, Tool, Hook) doesn't change as features are added; new features register as Tools or Hooks, never as core changes. Years of features can land without modifying the primitives. Plugin authors learn the registration mechanism once and gain access to every extension point. The cost of a new feature stays constant over time — exactly what a long-term substrate requires.

## Related

- [[wiki/specs/sdk-surface]] — Tool catalog and the Effect type.
- [[wiki/specs/prompts-and-workflows]] — workflow definitions (prompts with frontmatter).
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] — hooks observe and propose; Tools mutate.
- [[wiki/matrices/event-types-and-payloads]] — canonical event taxonomy.
- [[wiki/gotchas/async-read-after-write-staleness]] — reads after writes may not see hook follow-on.
- [[wiki/gotchas/hook-cycle]] — depth limit prevents infinite loops.
- [[wiki/invariants/SENSITIVE_GOES_TO_INBOX]] — opt-in invariant the `sensitivity-classify` workflow + a hook implement.
