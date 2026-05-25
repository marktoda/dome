---
type: matrix
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Tool × Invariant enforcement matrix

Which Tool enforces which Invariant, by what mechanism, and what test guarantees the enforcement. Exhaustive over the 7 SDK Tools × 9 Tool-boundary-enforced invariants. Invariant tier is shown in the header row.

`VAULT_IS_GIT_REPO` (the 10th invariant) is enforced at vault-open boundary, not at Tool call-site — `openVault(path)` refuses non-git directories. It does not appear in this matrix because no Tool ever interacts with it; it's a precondition for the entire Vault instance.

A blank cell means no relationship: the Tool doesn't touch that invariant's surface. Bolded cells mean active enforcement (the Tool refuses operations that would violate the invariant). Cells in *italics* are read-only relationships.

## Tier legend

- **Axiom** — non-disable-able. Disabling changes what Dome is.
- **Default** — shipped enabled; opt-out per vault.
- **Opt-in** — shipped disabled; opt-in per vault.

## Matrix

| Tool ↓ \ Invariant → | RAW_IS_IMMUTABLE *(axiom)* | MARKDOWN_IS_SOURCE_OF_TRUTH *(axiom)* | LOG_IS_APPEND_ONLY *(axiom)* | HOOKS_CANNOT_BYPASS_TOOLS *(axiom)* | EVERY_WRITE_IS_LOGGED *(default)* | PAGE_TYPE_BY_DIRECTORY *(default)* | WIKILINKS_ARE_FULLPATH *(default)* | SENSITIVE_GOES_TO_INBOX *(opt-in)* | PAGE_CREATION_REQUIRES_RECURRENCE *(opt-in)* |
|---|---|---|---|---|---|---|---|---|---|
| `readDocument` | *(read-only)* | *(read-only)* |  |  |  |  | *(parses links to detect)* |  |  |
| `writeDocument` | **rejects raw/** | *(writes markdown only)* |  |  | **emits appendLog effect when default enabled** | **validates path → type; rejects unknown subdir or frontmatter/dir mismatch when default enabled** | **rejects body with short-form links when default enabled** | **when opt-in enabled: rejects writes to wiki/ when sensitivity_classified='sensitive'** | **when opt-in enabled: requires reason on create** |
| `appendLog` |  | *(writes markdown only)* | **only mutator of log.md** |  | *(the enforcement target)* |  |  |  |  |
| `searchIndex` | *(read-only)* | *(read-only)* |  |  |  |  |  |  |  |
| `wikilinkResolve` | *(read-only)* |  |  |  |  |  | **only accepts full-path; returns null on short-form when default enabled** |  |  |
| `moveDocument` | **rejects raw/ source or target** | *(writes markdown only)* |  |  | **emits appendLog effect when default enabled** | **validates new path → type** |  |  |  |
| `deleteDocument` | **rejects raw/ target** | *(writes markdown only)* |  |  | **emits appendLog effect when default enabled** |  |  |  |  |
| *(Hook handlers)* |  |  |  | **structurally cannot mutate; can only call Tools** |  |  |  |  |  |

## Reading the matrix

- The four axiom invariants are enforced unconditionally — the Tool refuses violations regardless of vault config.
- Default-tier invariants are enforced when the vault's `.dome/config.yaml` doesn't disable them (the default state).
- Opt-in invariants are inert unless the vault explicitly enables them in `.dome/config.yaml`.

## Test guarantees

Each bolded enforcement cell maps to a test in `tests/invariants/<INVARIANT>.test.ts`:

- `RAW_IS_IMMUTABLE` — tests for `writeDocument` and `moveDocument` (refuses raw/ targets unconditionally).
- `LOG_IS_APPEND_ONLY` — `appendLog` is the only Tool whose effects array contains `kind: 'appended-log'`.
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
- [[wiki/invariants/RAW_IS_IMMUTABLE]] (and all 8 other invariants)
- [[wiki/matrices/event-types-and-payloads]]
- [[wiki/matrices/intent-prompt-tools]]
