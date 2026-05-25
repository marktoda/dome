---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# INDEX_AND_LOG_ARE_DISPATCHER_OWNED

**Tier:** Axiom — non-disable-able.

**Statement:** `<vault>/index.md` and `<vault>/log.md` are mutated only by the SDK dispatcher's privileged internal API — `dispatcher.writeIndex(entry)` and `dispatcher.appendLogEntry(entry)`. The public Tool catalog refuses these paths: `writeDocument('index.md', ...)`, `moveDocument(..., 'index.md')`, `deleteDocument('index.md')` (and the same for `log.md`) return `Result.err({ kind: 'dispatcher-owned-path' })` unconditionally. `appendLog` is the public Tool that calls `dispatcher.appendLogEntry` internally for hooks and workflows.

**Why:** `index.md` and `log.md` have a single legitimate owner each — the dispatcher. The index is rebuildable from the wiki on demand; the log is append-only audit. Allowing arbitrary callers to write either file produces races (multiple writers stomping each other) and corrupts the audit story (a malicious or buggy hook overwriting log.md). Constraining mutation to a single privileged path makes the ownership structural rather than reviewer-dependent.

The privileged dispatcher API is also **not** part of the registration mechanism: plugins cannot register their own dispatcher-owned paths or invoke `dispatcher.writeIndex` / `dispatcher.appendLogEntry`. The two paths are fixed; new dispatcher-owned files require an axiom-level change to this invariant.

**Structural enforcement:** Three layers:

1. **Public Tools reject.** `writeDocument`, `moveDocument`, and `deleteDocument` parse the target `path` argument. If it resolves to `index.md` or `log.md` at vault root, the Tool returns `Result.err({ kind: 'dispatcher-owned-path', path, requested_tool: '...' })`. No conditional logic; no flag bypass; rejection is unconditional.
2. **Privileged API is module-private.** The dispatcher's `writeIndex` and `appendLogEntry` are not exported from the SDK's public surface. The `appendLog` Tool is implemented as a thin wrapper that calls `dispatcher.appendLogEntry` internally. Shipped-default hooks (`auto-update-index`) reach the privileged API through a `dispatcher` field on the `HookContext` exposed only to built-in handlers — plugin and vault-local hooks receive a `HookContext` without that field. **Effect emission:** `dispatcher.writeIndex` and `dispatcher.appendLogEntry` produce `wrote-document` and `appended-log` Effects through the same Effect pipeline as public Tools — the event taxonomy (`document.written.index`, `log.appended`) in [[wiki/matrices/event-types-and-payloads]] is reachable uniformly regardless of whether the writer is a public Tool or the privileged dispatcher API. This is what lets hook handlers subscribe to `log.appended` events without caring which surface produced them, and what keeps the projection rule (Effect → event) free of writer-specific carve-outs.
3. **Reconciliation tolerates manual edits.** A user editing `log.md` or `index.md` directly in their editor produces an out-of-band edit (caught by the filesystem watcher → `vault.out-of-band-edit` event). `dome doctor --rebuild-index` regenerates from the wiki; out-of-band log edits are flagged but not auto-corrected (the user owns their markdown per `MARKDOWN_IS_SOURCE_OF_TRUTH`).

**Counter-example:** A plugin registers a hook that, on `document.written.wiki.entity`, attempts `ctx.tools.writeDocument('log.md', '<custom audit entry>', {}, { create: false })`. The Tool detects the dispatcher-owned path and rejects with `Result.err({ kind: 'dispatcher-owned-path', path: 'log.md', requested_tool: 'writeDocument' })`. The plugin must instead call `ctx.tools.appendLog({ verb: 'audit', subject: 'custom entry' })` — which goes through the public surface, lands as a normal log entry, and inherits all the LOG_IS_APPEND_ONLY guarantees.

**Counter-example #2 (built-in handler):** `auto-update-index` is a shipped-default hook. Its `HookContext` includes the `dispatcher` field. The handler calls `ctx.dispatcher.writeIndex(updatedEntry)` directly. A plugin attempting the same call against its `HookContext` finds `ctx.dispatcher` is `undefined` — the privileged API is not present on non-built-in handler contexts.

**Test guarantee:** `tests/invariants/index-and-log-are-dispatcher-owned.test.ts` — for each of `writeDocument`, `moveDocument`, `deleteDocument`, asserts calls with `path: 'index.md'` and `path: 'log.md'` return `Result.err({ kind: 'dispatcher-owned-path' })`. Asserts the `appendLog` Tool is the only public path that mutates `log.md`. Asserts the `HookContext.dispatcher` field is `undefined` for plugin and vault-local hook handlers and defined for shipped-default handlers. Asserts `dome doctor --rebuild-index` reaches `dispatcher.writeIndex` (not `writeDocument`).

**Related:**
- [[wiki/specs/sdk-surface]] §"Hook" (shipped-default hooks describe the privileged-API access pattern) and §"Tool catalog" (the affected Tool rows enforce this invariant).
- [[wiki/specs/hooks]] §`auto-update-index` (the canonical shipped-default consumer of `dispatcher.writeIndex`).
- [[wiki/specs/vault-layout]] §"Ownership rules" (index.md + log.md rows).
- [[wiki/specs/cli]] §"dome doctor" `--rebuild-index` flag.
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] (the append-only semantic this invariant structurally protects).
- [[wiki/matrices/tool-invariant-enforcement]] §"Matrix" (the column for this invariant).
