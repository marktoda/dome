---
type: matrix
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Tool × Invariant enforcement matrix

Which Tool enforces which Invariant, by what mechanism, and what test guarantees the enforcement. Exhaustive over the SDK Tool catalog (see [[wiki/specs/sdk-surface]] §"Tool catalog") × all invariants whose enforcement seam is the Tool call site or the hook-type-system boundary. Invariant tier is shown in the header row.

Three invariants are NOT in the matrix because they aren't enforced at Tool call-site or hook boundary:

- **`VAULT_IS_GIT_REPO`** — enforced at vault-open boundary; `openVault(path)` refuses non-git directories. A precondition for the entire Vault instance.
- **`INBOX_IS_EPHEMERAL`** — enforced at workflow-prompt level (intake workflows include explicit `deleteDocument(inbox_path)` exit-steps as part of their prompt instructions; see [[wiki/invariants/INBOX_IS_EPHEMERAL]] §"v0.5 escape mechanism" for why deletion is the v0.5 mechanism rather than `moveDocument` to `raw/`). See §"`INBOX_IS_EPHEMERAL` — workflow-enforced (off-matrix)" below; `dome doctor` reports stale inbox files as the structural fallback. This is *weaker than Tool-boundary enforcement* and is flagged in [[wiki/gotchas/agent-prompt-regression]] as a prompt-only-enforcement surface.
- **`CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY`** — enforced at the **bundle boundary**; the `@dome/sdk` core entrypoint (`src/index.ts`) may not transitively depend on `@anthropic-ai/sdk`, `ai`, or `@modelcontextprotocol/sdk`. Structurally enforced by `tests/integration/bundle-deps.test.ts`. No Tool refuses an invariant-violating call for this one; the enforcement happens at packaging time, not call time. See §"`CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` — bundle-enforced (off-matrix)" below.

A blank cell means no relationship: the Tool doesn't touch that invariant's surface. Bolded cells mean active enforcement (the Tool refuses operations that would violate the invariant). Cells in *italics* are read-only relationships.

## Tier legend

- **Axiom** — non-disable-able. Disabling changes what Dome is.
- **Shipped default** — enabled by default; opt-out per vault.
- **Opt-in** — shipped disabled; opt-in per vault.

## Matrix

| Tool ↓ \ Invariant → | RAW_IS_IMMUTABLE *(axiom)* | MARKDOWN_IS_SOURCE_OF_TRUTH *(axiom)* | LOG_IS_APPEND_ONLY *(axiom)* | HOOKS_CANNOT_BYPASS_TOOLS *(axiom)* | INDEX_AND_LOG_ARE_DISPATCHER_OWNED *(axiom)* | EVERY_WRITE_IS_LOGGED *(default)* | PAGE_TYPE_BY_DIRECTORY *(default)* | WIKILINKS_ARE_FULLPATH *(default)* | SENSITIVE_GOES_TO_INBOX *(opt-in)* | PAGE_CREATION_REQUIRES_RECURRENCE *(opt-in)* |
|---|---|---|---|---|---|---|---|---|---|---|
| `readDocument` | *(read-only)* | *(read-only)* |  |  |  |  |  | *(returns parsed wikilinks via `linksOut`; does not validate or reject)* |  |  |
| `writeDocument` | **rejects raw/** | *(writes markdown only)* |  |  | **rejects index.md and log.md unconditionally** | **emits appendLog effect when default enabled** | **validates path → type; rejects unknown subdir or frontmatter/dir mismatch when default enabled** | **rejects body with short-form links when default enabled** | **when opt-in enabled: rejects writes to wiki/ when sensitivity_classified='sensitive'** | **when opt-in enabled: requires reason on create** |
| `appendLog` |  | *(writes markdown only)* | **only public mutator of log.md** |  | *(public API; calls dispatcher.appendLogEntry internally)* | *(the primitive; other mutating Tools call this to satisfy the invariant)* |  |  |  |  |
| `searchIndex` | *(read-only)* | *(read-only)* |  |  |  |  |  |  |  |  |
| `wikilinkResolve` | *(read-only)* |  |  |  |  |  |  | **only accepts full-path; returns null on short-form when default enabled** |  |  |
| `moveDocument` | **rejects raw/ source or target** | *(writes markdown only)* |  |  | **rejects index.md and log.md unconditionally** | **emits appendLog effect when default enabled** | **validates new path → type** |  |  |  |
| `deleteDocument` | **rejects raw/ target** | *(writes markdown only)* |  |  | **rejects index.md and log.md unconditionally** | **emits appendLog effect when default enabled** |  |  |  |  |
| *(Hook handlers)* |  |  |  | **structurally cannot mutate; can only call Tools** |  |  |  |  |  |  |

### `INBOX_IS_EPHEMERAL` — workflow-enforced (off-matrix)

Not a column above because no Tool refuses an invariant-violating call for it. Enforcement lives in the **intake workflow prompts**: `ingest`, `voice-ingest`, `research`, `clip-integrate` each include an explicit `deleteDocument(inbox_path)` exit-step in their prompt instructions (per [[wiki/invariants/INBOX_IS_EPHEMERAL]] §"v0.5 escape mechanism" — deletion rather than `moveDocument`-to-`raw/` because `RAW_IS_IMMUTABLE` blocks the latter). The structural fallback is `dome doctor` reporting inbox files older than `hooks.inbox_stale_age_hours` in `.dome/config.yaml` (default 24h, excluding `inbox/review/` because `review/` is a destination not an intake). See [[wiki/invariants/INBOX_IS_EPHEMERAL]] and the prompt-only-enforcement caveat in [[wiki/gotchas/agent-prompt-regression]].

### `CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY` — bundle-enforced (off-matrix)

Not a column above because no Tool refuses an invariant-violating call for it; the boundary is the package-bundling layer, not the call site. Enforcement lives in `tests/integration/bundle-deps.test.ts`, which introspects the transitive dependency set of the `@dome/sdk` core entrypoint (`src/index.ts`) and asserts that `@anthropic-ai/sdk`, `ai`, and `@modelcontextprotocol/sdk` are NOT among them. A regression — e.g., re-exporting `runWorkflow` from `src/index.ts` — produces a failing test in CI before the regression merges. See [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] for the rationale and [[wiki/matrices/consumer-surface]] for which entrypoint each consumer shell uses.

## Reading the matrix

- The axiom invariants are enforced unconditionally — the Tool refuses violations regardless of vault config.
- Shipped-default invariants are enforced when the vault's `.dome/config.yaml` doesn't disable them (the default state).
- Opt-in invariants are inert unless the vault explicitly enables them in `.dome/config.yaml`.

## Test guarantees

Each bolded enforcement cell maps to a test in `tests/invariants/<INVARIANT>.test.ts`:

- `RAW_IS_IMMUTABLE` — tests for `writeDocument`, `moveDocument`, and `deleteDocument` (refuses raw/ targets unconditionally).
- `INDEX_AND_LOG_ARE_DISPATCHER_OWNED` — tests for `writeDocument`, `moveDocument`, `deleteDocument` (refuses `index.md` and `log.md` unconditionally with `kind: 'dispatcher-owned-path'`); asserts `HookContext.dispatcher` is `undefined` for plugin / vault-local handlers and defined for shipped-default handlers.
- `LOG_IS_APPEND_ONLY` — `appendLog` is the only public Tool whose effects array contains `kind: 'appended-log'`; internally calls `dispatcher.appendLogEntry`.
- `EVERY_WRITE_IS_LOGGED` — when enabled, mutating Tools' effects include at least one `kind: 'appended-log'`. When disabled, log entries are optional.
- `PAGE_TYPE_BY_DIRECTORY` — when enabled, `writeDocument` and `moveDocument` enforce directory/type matching.
- `WIKILINKS_ARE_FULLPATH` — when enabled, `writeDocument` rejects short-form links in bodies; `wikilinkResolve` rejects short-form input.
- `SENSITIVE_GOES_TO_INBOX` — when enabled, `writeDocument` refuses sensitive writes to `wiki/` paths.
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
