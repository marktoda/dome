---
type: matrix
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Tool × Invariant enforcement matrix

Which Tool enforces which Invariant, by what mechanism, and what test guarantees the enforcement. Exhaustive over the SDK Tool catalog (see [[wiki/specs/sdk-surface]] §"Tool catalog") × all invariants whose enforcement seam is the Tool call site or the hook-type-system boundary. Invariant tier is shown in the header row.

Five invariants are NOT in the matrix because they aren't enforced at Tool call-site or hook boundary:

- **`VAULT_IS_GIT_REPO`** — enforced at vault-open boundary; `openVault(path)` refuses non-git directories. A precondition for the entire Vault instance.
- **`INBOX_IS_EPHEMERAL`** — enforced at workflow-prompt level (intake workflows include explicit `deleteDocument(inbox_path)` exit-steps as part of their prompt instructions; see [[wiki/invariants/INBOX_IS_EPHEMERAL]] §"v0.5 escape mechanism" for why deletion is the v0.5 mechanism rather than `moveDocument` to `raw/`). See §"`INBOX_IS_EPHEMERAL` — workflow-enforced (off-matrix)" below; `dome doctor` reports stale inbox files as the structural fallback. This is *weaker than Tool-boundary enforcement* and is flagged in [[wiki/gotchas/agent-prompt-regression]] as a prompt-only-enforcement surface.
- **`CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`** — enforced at the **bundle boundary**; the `@dome/sdk` core entrypoint (`src/index.ts`) may not transitively depend on `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk`. Structurally enforced by `tests/integration/bundle-deps.test.ts`. No Tool refuses an invariant-violating call for this one; the enforcement happens at packaging time, not call time. See §"`CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` — bundle-enforced (off-matrix)" below.
- **`WORKFLOWS_KNOW_VAULT_CONTEXT`** — enforced at the **workflow-runner boundary**; `runWorkflow` composes `${buildSystemPreamble(vault)}\n\n${def.body}` as the `system` parameter to `generateText` for every workflow invocation. No Tool refuses an invariant-violating call for this one; the enforcement happens at the runner. See §"`WORKFLOWS_KNOW_VAULT_CONTEXT` — runner-enforced (off-matrix)" below; the AC3-lockstep test is `tests/invariants/workflows-know-vault-context.test.ts`.
- **`HOOK_DISPATCH_IS_VAULT_BOUND`** — enforced at the **projection-construction boundary**; every projection of `vault.tools` (`projectAiSdk(vault)`, `renderMcp(surface).tools`, future protocol renderers) routes mutating-Tool invocations through the single-source helper `wrapMutatingInvoke(vault, entry, writer)` in `src/tools/registry.ts`. No Tool refuses an invariant-violating call for this one; the enforcement happens at projection-construction time. See §"`HOOK_DISPATCH_IS_VAULT_BOUND` — projection-enforced (off-matrix)" below; the AC3-lockstep tests are `tests/integration/mcp-hook-dispatch.test.ts` (MCP path) and `tests/integration/ai-sdk-hook-dispatch.test.ts` (AI-SDK path).

A blank cell means no relationship: the Tool doesn't touch that invariant's surface. Bolded cells mean active enforcement (the Tool refuses operations that would violate the invariant). Cells in *italics* are read-only relationships.

## Tier legend

- **Axiom** — non-disable-able. Disabling changes what Dome is.
- **Shipped default** — enabled by default; opt-out per vault.
- **Opt-in** — shipped disabled; opt-in per vault.

## Matrix

| Tool ↓ \ Invariant → | RAW_IS_IMMUTABLE *(axiom)* | MARKDOWN_IS_SOURCE_OF_TRUTH *(axiom)* | LOG_IS_APPEND_ONLY *(axiom)* | HOOKS_CANNOT_BYPASS_TOOLS *(axiom)* | INDEX_AND_LOG_ARE_DISPATCHER_OWNED *(axiom)* | EVERY_WRITE_IS_LOGGED *(default)* | PAGE_TYPE_BY_DIRECTORY *(default)* | WIKILINKS_ARE_FULLPATH *(default)* | PAGE_CREATION_REQUIRES_RECURRENCE *(opt-in)* |
|---|---|---|---|---|---|---|---|---|---|
| `readDocument` | *(read-only)* | *(read-only)* |  |  |  |  |  | *(returns parsed wikilinks via `linksOut`; does not validate or reject)* |  |
| `writeDocument` | **rejects raw/** | *(writes markdown only)* |  |  | **rejects index.md and log.md unconditionally** | **emits appendLog effect when default enabled** | **validates path → type; rejects unknown subdir or frontmatter/dir mismatch when default enabled** | **rejects body with short-form links when default enabled** | **when opt-in enabled: requires reason on create** |
| `appendLog` |  | *(writes markdown only)* | **only public mutator of log.md** |  | *(public API; calls dispatcher.appendLogEntry internally)* | *(the primitive; other mutating Tools call this to satisfy the invariant)* |  |  |  |
| `searchIndex` | *(read-only)* | *(read-only)* |  |  |  |  |  |  |  |
| `wikilinkResolve` | *(read-only)* |  |  |  |  |  |  | **only accepts full-path; returns null on short-form when default enabled** |  |
| `moveDocument` | **rejects raw/ source or target** | *(writes markdown only)* |  |  | **rejects index.md and log.md unconditionally** | **emits appendLog effect when default enabled** | **validates new path → type** |  |  |
| `deleteDocument` | **rejects raw/ target** | *(writes markdown only)* |  |  | **rejects index.md and log.md unconditionally** | **emits appendLog effect when default enabled** |  |  |  |
| *(Hook handlers)* |  |  |  | **structurally cannot mutate; can only call Tools** |  |  |  |  |  |

### `INBOX_IS_EPHEMERAL` — workflow-enforced (off-matrix)

Not a column above because no Tool refuses an invariant-violating call for it. Enforcement lives in the **intake workflow prompts**: `ingest`, `voice-ingest`, `research`, `clip-integrate` each include an explicit `deleteDocument(inbox_path)` exit-step in their prompt instructions (per [[wiki/invariants/INBOX_IS_EPHEMERAL]] §"v0.5 escape mechanism" — deletion rather than `moveDocument`-to-`raw/` because `RAW_IS_IMMUTABLE` blocks the latter). The structural fallback is `dome doctor` reporting inbox files older than `hooks.inbox_stale_age_hours` in `.dome/config.yaml` (default 24h, excluding `inbox/review/` because `review/` is a destination not an intake). See [[wiki/invariants/INBOX_IS_EPHEMERAL]] and the prompt-only-enforcement caveat in [[wiki/gotchas/agent-prompt-regression]].

### `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` — bundle-enforced (off-matrix)

Not a column above because no Tool refuses an invariant-violating call for it; the boundary is the package-bundling layer, not the call site. Enforcement lives in `tests/integration/bundle-deps.test.ts`, which introspects the transitive dependency set of the `@dome/sdk` core entrypoint (`src/index.ts`) and asserts that `@ai-sdk/anthropic`, `ai`, and `@modelcontextprotocol/sdk` are NOT among them. A regression — e.g., re-exporting `runWorkflow` from `src/index.ts` — produces a failing test in CI before the regression merges. See [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] for the rationale and [[wiki/matrices/consumer-surface]] for which entrypoint each consumer shell uses.

### `WORKFLOWS_KNOW_VAULT_CONTEXT` — runner-enforced (off-matrix)

Not a column above because no Tool refuses an invariant-violating call for it; the boundary is the workflow-runner layer (`src/workflows/agent-loop.ts`'s `runWorkflow`), not the call site. Enforcement lives in `tests/invariants/workflows-know-vault-context.test.ts`, which pins the preamble composition contract: (a) every `runWorkflow` invocation prepends `buildSystemPreamble(vault)` to the workflow's body before passing the result to `generateText`; (b) `buildSystemPreamble` composes preambles in registration order with blank-line separators; (c) empty-returning preambles drop cleanly without introducing blank sections; (d) the vault-identity section appears before the rendering-surface section. See [[wiki/invariants/WORKFLOWS_KNOW_VAULT_CONTEXT]] for the rationale and the extension model (SDK-internal in v0.5; plugin/vault preamble registration deferred to v0.5.1+).

### `HOOK_DISPATCH_IS_VAULT_BOUND` — projection-enforced (off-matrix)

Not a column above because no Tool refuses an invariant-violating call for it; the boundary is the projection-construction layer (`bindTools` / `bindAiSdkTools` / future `renderHttp` / `renderVoice`), not the call site. Enforcement lives in two integration tests: `tests/integration/mcp-hook-dispatch.test.ts` (asserts a `writeDocument` via the MCP-rendered surface triggers `auto-update-index`) and `tests/integration/ai-sdk-hook-dispatch.test.ts` (asserts the same via `projectAiSdk(vault)`). The structural fence is the single-source helper `wrapMutatingInvoke(vault, entry, writer)` in `src/tools/registry.ts`: every projection consumes the helper rather than inlining the dispatch loop. A future projection that re-implements the wrap inline produces hook-dispatch behavior that drifts from the canonical helper's; the parallel integration test the future projection should ship catches the drift. See [[wiki/invariants/HOOK_DISPATCH_IS_VAULT_BOUND]] for the rationale.

## Reading the matrix

- The axiom invariants are enforced unconditionally — the Tool refuses violations regardless of vault config.
- Shipped-default invariants are enforced when the vault's `.dome/config.yaml` doesn't disable them (the default state).
- Opt-in invariants are inert unless the vault explicitly enables them in `.dome/config.yaml`.

## Lockstep status

This matrix is **lockstep-checked**: `tests/integration/matrix-coverage.test.ts` parses the matrix table above and asserts every bolded cell maps to an assertion in the named invariant's `tests/invariants/<slug>.test.ts` file. Adding a new bolded cell without the corresponding test assertion fails the lockstep test.

The off-matrix invariants below carry the delegating-stub lockstep shape described in [[wiki/specs/sdk-surface]] §"Off-matrix lockstep convention": each `tests/invariants/<slug>.test.ts` file dynamically imports the canonical enforcement test (`tests/integration/bundle-deps.test.ts`, `tests/integration/mcp-hook-dispatch.test.ts`, etc.) rather than carrying an `expect(true).toBe(true)` no-op. The AC3 meta-check at `tests/integration/invariant-coverage.test.ts` rejects no-op stubs by requiring each lockstep file to either run a `describe()` referencing an enforcement test (off-matrix) or contain at least one `expect()` against vault state (on-matrix).

Three sibling matrices remain **documentary** in v0.5 (not lockstep-checked): [[wiki/matrices/consumer-surface]], [[wiki/matrices/event-types-and-payloads]], [[wiki/matrices/intent-prompt-tools]]. Each carries a "Lockstep status" line near its top. The matrix-coverage test extends to [[wiki/matrices/consumer-surface]] in v0.5.1 (the highest-stakes v1 surface contract) once the cell-format parser lands; the other two are documentary by design because their cells are not machine-shape (free-form event names; bound-tool lists per workflow that are validated by `prompts/workflow-frontmatter.ts` already).

## Test guarantees

Each bolded enforcement cell maps to a test in `tests/invariants/<INVARIANT>.test.ts`. Off-matrix invariants (`VAULT_IS_GIT_REPO`, `INBOX_IS_EPHEMERAL`, `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`, `WORKFLOWS_KNOW_VAULT_CONTEXT`, `HOOK_DISPATCH_IS_VAULT_BOUND`) carry their structural-enforcement tests at the boundaries named in the off-matrix sections above; the AC3 invariant-coverage lockstep test accepts those named tests as the lockstep counterpart and rejects no-op stubs per the convention in [[wiki/specs/sdk-surface]] §"Off-matrix lockstep convention".

- `RAW_IS_IMMUTABLE` — tests for `writeDocument`, `moveDocument`, and `deleteDocument` (refuses raw/ targets unconditionally).
- `INDEX_AND_LOG_ARE_DISPATCHER_OWNED` — tests for `writeDocument`, `moveDocument`, `deleteDocument` (refuses `index.md` and `log.md` unconditionally with `kind: 'dispatcher-owned-path'`); asserts `HookContext.dispatcher` is `undefined` for plugin / vault-local handlers and defined for shipped-default handlers.
- `LOG_IS_APPEND_ONLY` — `appendLog` is the only public Tool whose effects array contains `kind: 'appended-log'`; internally calls `dispatcher.appendLogEntry`.
- `EVERY_WRITE_IS_LOGGED` — when enabled, mutating Tools' effects include at least one `kind: 'appended-log'`. When disabled, log entries are optional.
- `PAGE_TYPE_BY_DIRECTORY` — when enabled, `writeDocument` and `moveDocument` enforce directory/type matching.
- `WIKILINKS_ARE_FULLPATH` — when enabled, `writeDocument` rejects short-form links in bodies; `wikilinkResolve` rejects short-form input.
- `PAGE_CREATION_REQUIRES_RECURRENCE` — when enabled, `writeDocument` with `create: true` and no `reason` returns an error.
- `HOOKS_CANNOT_BYPASS_TOOLS` — type-level test on `HookContext` + runtime watcher test for out-of-band writes from hook contexts.

Each invariant doc carries the canonical statement + counter-example + test-guarantee.

## Cells that may grow

Plugins that add Tools declare which invariants they enforce. The matrix is regenerated from declared metadata at `dome doctor` time, surfacing any plugin Tool that touches the vault but doesn't enforce relevant invariants.

## Related

- [[wiki/specs/sdk-surface]]
- [[wiki/invariants/RAW_IS_IMMUTABLE]] (and the rest of the named-invariants catalog under `wiki/invariants/`)
- [[wiki/matrices/event-types-and-payloads]]
- [[wiki/matrices/intent-prompt-tools]]
