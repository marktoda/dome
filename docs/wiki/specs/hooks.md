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

### v0.5 scope note

The **declarative `.dome/hooks/*.yaml` loader** ships in v0.5: `openVault` reads
every YAML in `<vault>/.dome/hooks/` and registers each as a hook whose handler
invokes `runWorkflow(vault, frontmatter.workflow, ...)`. This is what makes the
shipped-default `intake-raw.yaml` fire when a file lands in `inbox/raw/`.

The **programmatic `.dome/hooks/*.ts` loader** and the broader **plugin
registration** mechanism described in [[wiki/specs/sdk-surface]] §"Registration"
ship in v0.5.1. v0.5 ships the source partition in code (`HookSource =
"sdk" | "plugin" | "vault-local"` with `HookContext.dispatcher` only present
on `sdk` source) and the YAML declarative form; programmatic TS hooks beyond
the two shipped-defaults are deferred.

This is intentional: the source partition is structural enforcement of
[[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] and must be in place before any
non-SDK hook can register. Shipping the partition without the programmatic
loader keeps the contract honest — adding plugin hooks in v0.5.1 is a loader
addition, not a contract change.

### Programmatic — `.dome/hooks/*.ts`

```ts
import { registerHook } from "@dome/sdk";

// Handler signature: (event, ctx) — event carries the payload (path, diff, …
// depending on event kind); ctx carries dispatcher-bound resources (tools,
// vault metadata). See [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] for the
// canonical type definitions.
registerHook("document.written.wiki.entity", async (event, ctx) => {
  const { path, diff } = event;
  // Read other entity pages, search for mentions of the new entity name,
  // and add backlinks via ctx.tools.writeDocument(...).
});
```

The programmatic form supports arbitrary logic. The handler receives the event payload as the first argument and a `ctx: HookContext` object exposing the Vault's Tools as the second (NOT the filesystem; see [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]).

### Declarative — `.dome/hooks/*.yaml`

```yaml
event: document.written
path_pattern: "inbox/raw/*"     # optional filter on the path field
workflow: ingest                 # name of a prompt-with-workflow-frontmatter
async: true                      # optional; defaults to true
```

The declarative form is sugar for the common case: "when X happens, run workflow Y." The dispatcher reads the YAML, builds a handler that loads the named workflow's prompt + tool subset (see [[wiki/specs/prompts-and-workflows]]) and runs it against the harness-bound LLM.

#### Bare events expand to suffix wildcards

A declarative `event:` field that contains no `*` is rewritten by the YAML loader to `<event>.*` before registration. The rewrite is in `src/hooks/yaml-loader.ts` and is load-bearing for the common case:

```yaml
# YAML source
event: document.written
path_pattern: "inbox/raw/*"
workflow: ingest
```

Registers the handler against pattern `document.written.*` (not `document.written` literal) so it matches the projected `document.written.inbox.raw` event the `wrote-document` effect produces. The `path_pattern` field does the precise filtering against the event's `path` payload at handler time; the registry pattern is coarse-by-design so the matcher catches every category/type the event projector might emit.

Events that already contain `*` are honored verbatim — `event: document.written.wiki.*` is not double-expanded; `event: *` is not changed. The expansion only fires when the YAML's event string has no `*` character at all.

The rewrite is invisible to users of the declarative form (the YAML reads naturally; the right registration pattern is produced); it is visible to anyone writing a programmatic-form unit test or a custom YAML loader (they must register `document.written.*`, not `document.written`, to match projected events). [[wiki/matrices/event-types-and-payloads]] §"Expansion convention" mirrors the rule.

The **drop-zone intake pattern** uses the declarative form exclusively. The principle: a user (or another process) writes a file to a known directory, the hook fires, the workflow processes the file. This generalizes "quick capture" without any dedicated CLI machinery — `dome capture` becomes a shell idiom (`echo "$THOUGHT" > $VAULT/inbox/raw/$(date -u +%Y%m%d-%H%M%S).md`) and the hook does the rest. New capture kinds = new buckets + new hook YAMLs.

## Shipped default hooks (shipped default — enabled by default)

The SDK ships three hooks as shipped defaults — enabled in every vault unless explicitly disabled in `.dome/config.yaml`: `auto-update-index` and `auto-cross-reference` (both event-reactive, described in full below); plus `intake-raw`, the shipped-default intake hook that processes `inbox/raw/*` via the `ingest` workflow (described as part of the intake patterns in §"Intake patterns — shipped-default and opt-in" below — it's listed there rather than here because its shape is the canonical example of the drop-zone intake pattern, even though its enablement status is shipped-default).

### `auto-update-index`

```yaml
# Shipped with the SDK; equivalent vault-local form
event: document.written.wiki.*
async: true
handler: builtin:auto-update-index
```

Subscribes to all wiki write effects (and `document.deleted.wiki.*`). The handler reads the modified Document, computes the index entry, and writes the updated `index.md` via `dispatcher.writeIndex(entry)` — the privileged internal API documented in [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]. (Public Tools refuse `index.md`; the dispatcher field is present on shipped-default `HookContext`s only.) The handler is idempotent and cycle-safe (the index write itself doesn't match `document.written.wiki.*` because index.md is not under `wiki/`).

### `auto-cross-reference`

```yaml
event: document.written.wiki.entity
async: true
handler: builtin:auto-cross-reference
```

Subscribes to new or updated entity-page writes. The handler searches the wiki for **exact name matches** of the entity (case-sensitive; surrounded by word boundaries) in other pages' bodies, and calls `writeDocument` to add `[[wiki/entities/<name>]]` cross-references at the matching positions. The write is idempotent (the second run produces no diff because the wikilink is already there).

The handler is conservative: only exact matches trigger writes. Ambiguous matches (e.g., "Mark" could be one of several entities; pluralized forms; case-variants) emit a `cross-reference-candidate` event with the candidates and source; plugins or user hooks can subscribe and apply fuzzy-match heuristics. The shipped default doesn't try to be smart — fewer false positives is more important than catching every reference.

The exact-match conservatism is what keeps `auto-cross-reference` shipped-default-safe. A vault with rich entity backlinking benefits; a vault with name collisions across types gets nothing wrong (only matches that are unambiguous).

The shipped-default reactive hooks can be disabled in `.dome/config.yaml`:

```yaml
hooks:
  builtin:
    auto-update-index: enabled
    auto-cross-reference: disabled    # for vaults that don't want auto-backlinking
```

(The third shipped-default — `intake-raw` — is disabled by removing its YAML from `.dome/hooks/` or by removing the `inbox/raw/` directory; see §"Intake patterns" below for the activation-by-presence convention.)

## Intake patterns — shipped-default and opt-in

The SDK ships five hook *templates* for intake patterns. One is shipped-default; the other four are opt-in:

| Template name | Tier | Path pattern | Workflow invoked |
|---|---|---|---|
| `intake-raw` | shipped default | `inbox/raw/*` | `ingest` |
| `intake-voice` | opt-in | `inbox/voice/*` | `voice-ingest` |
| `intake-research` | opt-in | `inbox/research/*` | `research` |
| `intake-clip` | opt-in | `inbox/clip/*` | `clip-integrate` |

`dome init` creates `inbox/raw/` AND ships `.dome/hooks/intake-raw.yaml` — quick-capture works out of the box. The other four templates are inert until the user activates them by copying the template YAML from the SDK's `hooks/templates/` directory into `<vault>/.dome/hooks/` and creating the corresponding `inbox/<bucket>/` directory. A vault never has an `inbox/<bucket>/` it didn't explicitly enable (other than the default `inbox/raw/`).

A future "packs" or "presets" mechanism may layer one-command activation over the manual opt-in flow; v0.5 keeps the activation explicit.

### `inbox/review/` — lint-report destination

`inbox/review/` is the destination for `dome lint` reports. It is NOT an intake (no workflow runs on writes to it). It is a review queue: when `dome lint` runs, it writes a structured report under `inbox/review/lint-report-YYYY-MM-DD.md` with stable finding ids. The user reviews the report in Obsidian (or any markdown editor) and applies findings via `dome lint --apply <id>`. Each applied finding gets an annotation in the report (`Applied:` / `Apply-failed:`); the report itself stays in `inbox/review/` as audit history.

See [[wiki/specs/cli]] §"`dome lint`" for the full propose/apply contract.

(Note: prior to 2026-05-26, `inbox/review/` doubled as a destination for the now-retired sensitivity-classification feature. The directory is single-purpose under the compiler reframe — lint reports only.)

## Execution model

- **Async by default.** When a Tool returns its Effects, the Hook dispatcher enqueues matching events to a background queue and the Tool returns to its caller immediately.
- **Sync opt-in.** A hook may declare `async: false` (declarative) or pass `{ sync: true }` to `registerHook` (programmatic). Sync hooks run inline before the Tool returns. Reserved for hooks that must complete before downstream code observes the result — e.g., a classifier that gates a write destination, or any future hook with a hard pre-write contract.
- **Queue backend.** v0.5 ships with an in-process queue (`p-queue` instance per Vault). The backend is swappable via configuration; Redis-backed BullMQ is a reasonable v1 swap.
- **Failure model.** A hook handler that throws is logged as a `hook-failure` entry in `log.md`. The originating Tool call is not affected. Three consecutive failures of the same handler trigger `hook-disabled`; the handler is added to `.dome/state/quarantined.json` (the persistent quarantine record — see [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`") and is skipped on every subsequent event match across processes until `dome doctor --reset-quarantined-hooks` removes it. The persistence is necessary because `dome doctor` and `dome serve` don't share a process; an in-memory quarantine would not survive the CLI handoff.
- **Cycle prevention.** Two-layer mechanism: (1) **per-(handler, target-path) repetition check** — the primary mechanism. The dispatcher tracks a causation chain per event; when a handler would fire against an event whose `(handler_id, primary_target_path)` pair already appears earlier in the chain, the dispatcher refuses the fire and emits `hook.cycle-detected`. Legitimate fan-out (e.g., `auto-cross-reference` writing backlinks across N pages) is allowed because each target path is distinct. (2) **Depth safety net** — `hooks.max_causation_depth` in `.dome/config.yaml` (default 50) catches runaway chains that don't repeat (handler, target) but grow unboundedly. Either trigger emits `hook.cycle-detected` and refuses the fire. See [[wiki/gotchas/hook-cycle]].

### `.dome/config.yaml` hook-related fields

The `hooks:` section of the vault config carries the following fields (all shipped-default values live in `src/shipped-defaults.ts` — see [[wiki/specs/sdk-surface]] §"Tiered feature model"):

| Field | Default | Purpose |
|---|---|---|
| `hooks.builtin.<id>` | `enabled` | Per-shipped-default-hook on/off switch (`auto-update-index`, `auto-cross-reference`). |
| `hooks.max_causation_depth` | `50` | Cycle-prevention depth safety net (see §"Cycle prevention" above). |
| `hooks.inbox_stale_age_hours` | `24` | `dome doctor` `INBOX_IS_EPHEMERAL` check threshold (see [[wiki/invariants/INBOX_IS_EPHEMERAL]]). Files in `inbox/<bucket>/` (excluding `inbox/review/`) older than this age emit a violation. |

## Durability and reconciliation

Hooks are **durable** (crash-safe) and **at-least-once guaranteed** (every event that should have fired eventually does fire, even when `dome serve` isn't running). The mechanism is **state-based reconciliation** built on git (see [[wiki/invariants/VAULT_IS_GIT_REPO]]) — not an event log.

The durability story rests on three observations:

1. **The vault is canonical.** Filesystem state under `wiki/`, `raw/`, `inbox/`, etc. is the source of truth (per [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]). Any "did this hook fire?" question can be answered by comparing current state to a reconciliation checkpoint.
2. **Git tracks every content change.** `git diff --name-only <last-reconciled-sha> HEAD` + `git status --porcelain` together give us every file that changed since the last successful reconciliation. No custom hash-cache needed; no per-hook lockfiles needed.
3. **Inbox files signal pending work.** Per [[wiki/invariants/INBOX_IS_EPHEMERAL]], intake hooks MUST move/delete inbox files on completion. A file's presence in `inbox/<bucket>/` IS the "this is pending" signal.

These three signals are the inputs to `dome reconcile`. No event log is parsed; no log.md scanning; no separate event store; no per-hook lockfiles.

### Crash recovery without lockfiles

Per-workflow atomic commits (see §"Commit policy" below) combined with the idempotency contract make every hook-crash recovery case derivable from git + filesystem state alone — no lockfile mechanism needed:

| Crash scenario | Recovery |
|---|---|
| Workflow committed, hook hasn't fired yet, process died | `git diff <last-sha> HEAD` shows the workflow's commit; reconcile fires the event; hook runs |
| Workflow committed, hook started but applied no effects, crashed | Same as above — reconcile re-fires from git diff; hook runs from scratch (idempotent) |
| Workflow committed, hook applied partial effects, didn't commit, crashed | `git status` shows uncommitted partial work. User resolves (`git commit` if intentional; `git reset --hard HEAD` if broken). Reconcile then re-fires; idempotent hook re-runs cleanly. |
| Workflow committed, hook completed and committed, then crashed | Already complete; no diff visible to reconcile. |
| Scheduled hook fired, crashed before completion | `scheduled.json.last_fire` wasn't updated. Next reconcile sees interval elapsed; fires again. |
| External-side-effect hook (notify, sync) crashed mid-call | Hook declared `idempotent: false`; reconcile doesn't re-fire. User accepts at-most-once for external sinks. |

Every case is covered. Lockfiles would add complexity without solving a real problem.

### The three reconciliation phases

`dome reconcile` (invoked manually or automatically at `dome serve` startup) runs three phases:

```
Phase 1 — Inbox processing:
  for each file in inbox/<bucket>/:
    fire document.written.inbox.<bucket>
    (matching intake hook runs workflow, moves file to raw/<...>, completes)
  inbox/ ends empty when phase 1 completes successfully

Phase 2 — Git diff:
  read .dome/state/last-reconciled-sha.txt
  changed_files = git.statusMatrix(...)  # via isomorphic-git: uncommitted + staged
                  + git diff --name-only <last_sha> HEAD  # committed since last reconcile
  for each changed file in wiki/<type>/, raw/, etc.:
    fire document.written.<category>.<type> (or .deleted, .moved as appropriate)
    (auto-update-index, auto-cross-reference, etc. respond)
  write .dome/state/last-reconciled-sha.txt = current HEAD sha

Phase 3 — Scheduled catch-up:
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

Two files under `.dome/` are derived operational state, not canonical knowledge:

| Path | Purpose | If deleted, what happens |
|---|---|---|
| `.dome/state/last-reconciled-sha.txt` | Last reconciliation HEAD SHA | Next reconcile treats every file as changed (fires events for the whole vault once); idempotent so safe |
| `.dome/state/scheduled.json` | Last-fire timestamps for scheduled hooks | Next reconcile fires every scheduled hook once |

Both are gitignored — they're per-machine operational state and shouldn't sync across devices. The `.gitignore` shipped by `dome init` excludes them.

### Commit policy

Workflows commit at completion (per-workflow atomic commit). The mechanism:

1. **Workflow accumulates Effects in memory.** Each Tool call within the workflow appends to an in-memory effect list; no on-disk changes yet.
2. **At workflow completion**, the Effect list is applied to disk in one atomic batch: all writes happen via `writeDocument` / `moveDocument` / `deleteDocument` / `appendLog` against the filesystem.
3. **The workflow writes its `log.md` entry** via `appendLog` as part of the batch.
4. **The workflow commits**: `git add <paths-touched-by-workflow>` (selective, not `git add -A`); `git commit -m "<verb>: <subject>"`; commit body = log entry body. The commit message subject and the log.md entry's `## [date] verb | subject` line are byte-identical (modulo prefix conventions).
5. **On failure during steps 2-4**: `git reset --hard HEAD` rolls back working-tree changes; no commit is made; reconciliation will re-fire the originating event on next run.

Hooks run as their own workflows. The `auto-cross-reference` hook that writes backlinks across N pages commits all N writes + its log entry as ONE commit. The git history shows one commit per logical operation, not one per file write.

User out-of-band edits remain uncommitted unless the user explicitly commits. Reconciliation handles both committed (`git diff`) and uncommitted (`git status`) state.

**Configuration override**: `.dome/config.yaml` `git.auto_commit_workflows: false` disables per-workflow auto-commit. Reconciliation still works (uses `git status` for everything). Useful for users who want full manual commit control.

**Why this is the right default**: each workflow becomes an atomic, undoable unit; `git revert <commit>` is universal undo; reconciliation simplifies because committed state IS the latest known-reconciled state.

**`log.md` and `git log` are complementary, not redundant.** Per-workflow auto-commit keeps the two append-only operation histories aligned at the same byte-identical subject line, but they answer different questions: `log.md` is the *narrative* layer — readable in any markdown editor, greppable with `rg`, survives `tar` export without `.git/`, and catches events that don't produce commits (hook failures, hook quarantine, operations under `auto_commit_workflows: false`). `git log` is the *content-diff* layer — full diffs, time-travel via `git show`, attribution, blame. Both are load-bearing; see [[wiki/invariants/LOG_IS_APPEND_ONLY]] §"Why not just `git log`?" for the full case.

Specifically, hook-lifecycle events that don't map to a workflow commit (`hook-failed`, `hook-disabled`) flow to `log.md` only via `appendLog`. They have no representation in `git log`.

### Why this design beats a log-based event source

| Property | log.md as event source | State-based (this) |
|---|---|---|
| Source for "did X fire?" | Parse log.md | git diff + inbox files |
| Bootstrap cost | Parse entire log.md | Walk vault state (bounded by # files, not # operations) |
| log.md role | Audit + execution state (mixed) | Audit only |
| Honors MARKDOWN_IS_SOURCE_OF_TRUTH | Mixed — log.md becomes load-bearing | Clean — `.dome/state/*` is derived; vault is canonical |
| Reuses existing infra | No (custom log parsing) | Yes (git, already required by [[wiki/invariants/VAULT_IS_GIT_REPO]]) |
| Out-of-band edit detection | Needs separate tracking | Native (`git status` / `git diff`) |
| Crash recovery | log.md `hook-started` w/o matching `hook-completed` | Per-workflow atomic commits + idempotency contract make recovery filesystem-derivable |

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
- "Maintain a derived view of pages" → programmatic hook on `document.written.*` that updates an index page via `writeDocument`.
- "Schedule daily lint" → declarative hook on `clock.tick.daily` invoking the `lint` workflow.
- "Auto-cross-reference new entities" → the shipped `auto-cross-reference` hook (or your own variant).

If a feature can't be expressed as Tool registration + Hook registration, the four-concept core is missing something. The four-concept core is sealed; new behavior surfaces do not appear in v0.5. Future extension lands via Tool registration + Hook registration, never as new core primitives.

## Why this design

The hook system is what makes Dome stable as a substrate while flexible as a product. The four-concept core (Vault, Document, Tool, Hook) doesn't change as features are added; new features register as Tools or Hooks, never as core changes. Years of features can land without modifying the primitives. Plugin authors learn the registration mechanism once and gain access to every extension point. The cost of a new feature stays constant over time — exactly what a long-term substrate requires.

## Related

- [[wiki/specs/sdk-surface]] — Tool catalog and the Effect type.
- [[wiki/specs/prompts-and-workflows]] — workflow definitions (prompts with frontmatter).
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] — hooks observe and propose; Tools mutate.
- [[wiki/matrices/event-types-and-payloads]] — canonical event taxonomy.
- [[wiki/gotchas/async-read-after-write-staleness]] — reads after writes may not see hook follow-on.
- [[wiki/gotchas/hook-cycle]] — per-(handler, target) repetition check + depth safety net.
