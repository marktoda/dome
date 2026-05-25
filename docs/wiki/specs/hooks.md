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

Subscribes to new or updated entity-page writes. The handler searches the wiki for **exact name matches** of the entity (case-sensitive; surrounded by word boundaries) in other pages' bodies, and calls `writePage` to add `[[wiki/entities/<name>]]` cross-references at the matching positions. The write is idempotent (the second run produces no diff because the wikilink is already there).

The handler is conservative: only exact matches trigger writes. Ambiguous matches (e.g., "Mark" could be one of several entities; pluralized forms; case-variants) emit a `cross-reference-candidate` event with the candidates and source; plugins or user hooks can subscribe and apply fuzzy-match heuristics. The shipped default doesn't try to be smart — fewer false positives is more important than catching every reference.

The exact-match conservatism is what keeps `auto-cross-reference` shipped-default-safe. A vault with rich entity backlinking benefits; a vault with name collisions across types gets nothing wrong (only matches that are unambiguous).

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

## Durability and reconciliation

Hooks are **durable** (crash-safe) and **at-least-once guaranteed** (every event that should have fired eventually does fire, even when `dome serve` isn't running). The mechanism is **state-based reconciliation** built on git (see [[wiki/invariants/VAULT_IS_GIT_REPO]]) — not an event log.

The durability story rests on four observations:

1. **The vault is canonical.** Filesystem state under `wiki/`, `raw/`, `inbox/`, etc. is the source of truth (per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]). Any "did this hook fire?" question can be answered by comparing current state to a reconciliation checkpoint.
2. **Git tracks every content change.** `git diff --name-only <last-reconciled-sha> HEAD` + `git status --porcelain` together give us every file that changed since the last successful reconciliation. No custom hash-cache needed.
3. **Inbox files signal pending work.** Per [[wiki/invariants/INBOX_IS_EPHEMERAL]], intake hooks MUST move/delete inbox files on completion. A file's presence in `inbox/<bucket>/` IS the "this is pending" signal.
4. **In-flight hooks leave lockfiles.** When a hook starts, it writes `.dome/in-flight/<handler-id>-<event-id>.json`. On completion, the lockfile is deleted. On crash, the lockfile survives. Reconciliation re-fires every event whose lockfile is still present.

These four signals are the inputs to `dome reconcile`. No event log is parsed; no log.md scanning; no separate event store.

### The four reconciliation phases

`dome reconcile` (invoked manually or automatically at `dome serve` startup) runs four phases:

```
Phase 1 — In-flight recovery:
  for each <handler>-<event-id>.json in .dome/in-flight/:
    re-fire the event from the lockfile's payload
    (idempotency contract makes re-fire safe)

Phase 2 — Inbox processing:
  for each file in inbox/<bucket>/:
    fire document.written.inbox.<bucket>
    (matching intake hook runs workflow, moves file to raw/<...>, completes)
  inbox/ ends empty when phase 2 completes successfully

Phase 3 — Git diff:
  read .dome/state/last-reconciled-sha.txt
  changed_files = git.statusMatrix(...)  # via isomorphic-git
                  + git diff --name-only <last_sha> HEAD
  for each changed file in wiki/<type>/, raw/, etc.:
    fire document.written.<category>.<type> (or .deleted, .moved as appropriate)
    (auto-update-index, auto-cross-reference, etc. respond)
  write .dome/state/last-reconciled-sha.txt = current HEAD sha

Phase 4 — Scheduled catch-up:
  read .dome/state/scheduled.json
  for each scheduled hook whose (now - last_fire) > interval:
    fire clock.tick.<interval>
    update scheduled.json[handler].last_fire = now
  (catch-up fires at most once per scheduled hook regardless of intervals missed)
```

### Dirty git state refusal

`dome reconcile` refuses to run when the vault is mid-merge, mid-rebase, or mid-cherry-pick. See [[wiki/gotchas/dirty-git-state-at-reconcile]] for the detection criteria and the recovery flow.

### The idempotency contract

Reconciliation can re-fire events. Hooks MUST tolerate this. Shipped defaults (`auto-update-index`, `auto-cross-reference`) are idempotent by construction. User-registered hooks declare idempotency:

```yaml
# declarative: idempotency defaults to true (assumed safe)
event: document.written.wiki.entity
workflow: my-workflow
idempotent: false  # opt out: reconciliation will skip this hook
```

```ts
// programmatic
registerHook("document.written.wiki.entity", {
  idempotent: false,
  async handler(event, ctx) { ... }
});
```

Hooks that opt out of idempotency are skipped during reconciliation. They only fire from live events (when `dome serve` is running and a Tool fires). This is the escape hatch for hooks that can't be made idempotent (e.g., a counter hook).

See [[wiki/gotchas/hook-non-idempotent]] for what happens when a hook isn't idempotent and is incorrectly declared idempotent.

### Hook lifecycle entries in log.md

For human readability, the dispatcher also appends `hook-started`, `hook-completed`, and `hook-failed` entries to `log.md`. These are NOT used by reconciliation — they're audit/debugging content. Removing them would make `log.md` thinner; keeping them makes `git log` and skim-reading more informative.

### Derived operational state

Three directories under `.dome/` are derived operational state, not canonical knowledge:

| Path | Purpose | If deleted, what happens |
|---|---|---|
| `.dome/cache/` | (reserved for future per-handler caches; empty in v0.5 base SDK) | N/A |
| `.dome/in-flight/<handler>-<event-id>.json` | Lockfiles for hooks in progress | Crash recovery loses any in-flight events that were running at delete time; reconcile re-fires what it can detect from git/inbox state |
| `.dome/state/last-reconciled-sha.txt` | Last reconciliation HEAD SHA | Next reconcile treats every file as changed (fires events for the whole vault once); idempotent so safe |
| `.dome/state/scheduled.json` | Last-fire timestamps for scheduled hooks | Next reconcile fires every scheduled hook once |

These are all gitignored — they're per-machine operational state and shouldn't sync across devices. The `.gitignore` shipped by `dome init` excludes them.

### Why this design beats a log-based event source

| Property | log.md as event source | State-based (this) |
|---|---|---|
| Source for "did X fire?" | Parse log.md | git diff + inbox files + lockfiles |
| Bootstrap cost | Parse entire log.md | Walk vault state (bounded by # files, not # operations) |
| log.md role | Audit + execution state (mixed) | Audit only |
| Honors MARKDOWN_IS_SOURCE_OF_TRUTH | Mixed — log.md becomes load-bearing | Clean — `.dome/*` is derived; vault is canonical |
| Reuses existing infra | No (custom log parsing) | Yes (git, already required by [[wiki/invariants/VAULT_IS_GIT_REPO]]) |
| Out-of-band edit detection | Needs separate tracking | Native (git status / git diff) |
| In-flight recovery | log.md `hook-started` w/o matching `hook-completed` | `.dome/in-flight/` lockfile presence |

State-based wins on every axis except "everything in one file," which isn't a property anyone needs.

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
