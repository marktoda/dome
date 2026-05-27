---
type: spec
created: 2026-05-25
updated: 2026-05-25
sources: ["[[raw/original-architecture]]", "[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Vault layout

This spec is normative for the on-disk shape of a Dome vault. The Vault layout is the user-visible contract: any markdown editor can open a Dome vault and see well-organized files in well-named directories.

## Vault root

A Dome vault is a directory containing:

```
<vault>/
  VISION.md             # (optional) user-authored north-star or charter
  README.md             # (optional) orientation file for new readers
  index.md              # catalog of all wiki pages (Dome-maintained, axiom)
  log.md                # append-only operations record (Dome-maintained, axiom)
  raw/                  # immutable user-provided sources
  notes/                # user-authored hand-written notes
  wiki/                 # Dome-synthesized pages, typed by subdirectory
    entities/
    concepts/
    sources/
    syntheses/
    <extension-types>/  # per-vault extension types declared in .dome/page-types.yaml
  inbox/                # drop-zone directories whose writes trigger hooks
    raw/                # shipped-default capture bucket (created by dome init)
    <intake-buckets>/   # opt-in intake buckets — voice/, research/, clip/ — activated via hook template + directory create
    review/             # shipped-default destination (NOT an intake) — created by `dome init`; holds `dome lint` reports awaiting user review; see wiki/specs/cli §"dome lint"
  .dome/                # vault-internal configuration and extensions
    page-types.yaml     # allowed page types: defaults + extensions (vault-local + bundle-contributed)
    config.yaml         # vault configuration (invariant overrides, hook settings, etc.)
    prompts/            # vault-local prompt overrides
    hooks/              # vault-local hooks: *.ts (programmatic) and *.yaml (declarative)
    tools/              # vault-local tool additions (rarely used)
    cli/                # vault-local CLI command additions (rarely used)
    extensions/         # extension bundles (per wiki/specs/sdk-surface §"Extension bundles")
      <bundle-name>/    # each bundle: manifest.yaml + any of page-types.yaml, preamble.md, workflows/, hooks/, cli/, tools/
    state/              # derived: scheduled.json, last-reconcile-mtime.txt, quarantined.json (gitignored)
  .git/                 # git repository (axiom: every Dome vault is a git repo)
  .gitignore            # excludes .dome/state/ (per-machine operational state)
```

`dome init` creates the axiom structure (vault root + raw/ + notes/ + wiki/ defaults + .dome/) AND `inbox/raw/` (the shipped-default capture bucket) AND `inbox/review/` (the shipped-default lint-report destination) AND `.git/` via `git init`. Additional opt-in intake buckets (`inbox/voice/`, `inbox/research/`, `inbox/clip/`) exist only when the vault activates the corresponding intake hook template — see [[wiki/specs/hooks]] §"Intake patterns — shipped-default and opt-in."

### Git repository structure

Every Dome vault is a git repository per [[wiki/invariants/VAULT_IS_GIT_REPO]]. The `.git/` directory at vault root is treated as `category: external` by Dome's tools (Dome never touches it; it's not enumerated; it's not part of any wiki).

What gets committed to git:

- `VISION.md`, `README.md`, `index.md`, `log.md` — committed.
- `raw/`, `notes/`, `wiki/`, `inbox/` — all committed. Reconciliation works against committed AND uncommitted state.
- `.dome/page-types.yaml`, `.dome/config.yaml`, `.dome/prompts/`, `.dome/hooks/`, `.dome/tools/`, `.dome/cli/`, `.dome/extensions/` — committed (these are the vault's identity, including which extension bundles the vault has installed).
- `.dome/state/` — **gitignored** (per-machine operational state: `last-reconcile-mtime.txt`, `scheduled.json`, `quarantined.json`).

### Derived operational state under `.dome/`

| Path | Role | If deleted |
|---|---|---|
| `.dome/state/last-reconcile-mtime.txt` | Mtime marker for `dome doctor --time-since-reconcile`; touched on every `dome sync` regardless of whether anything changed | Next `dome doctor --time-since-reconcile` reports "never" |
| `.dome/state/scheduled.json` | Last-fire timestamps for scheduled hooks | Next sync fires every scheduled hook once |
| `.dome/state/quarantined.json` | Hook handler quarantine list (handler IDs with three consecutive failures, per [[wiki/specs/hooks]] §"Execution model") | Quarantined handlers re-enter rotation at next process start; idempotent so safe |

All three files are derived state: deleting them doesn't lose canonical knowledge; deleting them just causes the next sync or hook-dispatch cycle to do more work. The vault's markdown content (under `wiki/`, `raw/`, etc.) is the only canonical surface.

The canonical "have I compiled this revision" cursor is `refs/dome/adopted/<branch>` (per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]]) — a first-class git artifact living under `.git/refs/dome/adopted/`, not under `.dome/state/`. The pre-phase1+phase3 substrate carried `.dome/state/last-reconciled-sha.txt` in this role; it has been retired in favor of the ref. Existing v0.5 vaults' `last-reconciled-sha.txt` files are tolerated (read for the `dome doctor --time-since-reconcile` fallback when `last-reconcile-mtime.txt` is absent) but no longer carry the cursor role — see [[wiki/specs/adoption]] §"Migration from v0.5".

(Plugins that need their own caches create their own subdirectories under `.dome/<plugin-name>/cache/` and gitignore them in the vault's `.gitignore`. The SDK base ships no `.dome/cache/` directory.)

## Category derivation

A Document's category is derived from the top-level directory in its `path`:

| Path prefix | Category | Notes |
|---|---|---|
| `raw/...` | `raw` | Immutable per [[wiki/invariants/RAW_IS_IMMUTABLE]] |
| `wiki/...` | `wiki` | Typed pages (entity / concept / source / synthesis / extension types) |
| `notes/...` | `notes` | User-authored; Dome reads, never writes |
| `inbox/...` | `inbox` | Ephemeral; intake hooks move/delete per [[wiki/invariants/INBOX_IS_EPHEMERAL]] |
| `log.md` | `log` | Append-only |
| `index.md` | `index` | Maintained by `auto-update-index` hook |
| `.dome/...` | `config` | Vault configuration + derived state |
| `.git/...` | `external` | Tolerated, never modified, never enumerated |
| (other top-level subdirs) | `external` | Unknown directories are tolerated as `external`; Dome ignores them. Use this for arbitrary user-organized content alongside Dome (e.g., this vault's `cohesive/` Cohesive session residue). |
| (other vault-root files) | `notes` (default) | |

The category determines mutability and which Tool may write to it. See [[wiki/matrices/tool-invariant-enforcement]] and [[wiki/invariants/RAW_IS_IMMUTABLE]].

External categories are tolerated by design — Dome plays well with vaults that have non-Dome content. `dome doctor` does not flag unknown subdirectories; they're invisible to Dome's tools.

## Type derivation (wiki/ only)

For paths under `wiki/<subdir>/<filename>.md`, the `<subdir>` is the page type. The allowed types are declared in `.dome/page-types.yaml`:

```yaml
defaults:
  - entity
  - concept
  - source
  - synthesis
extensions:
  - <vault-defined>
```

`writeDocument` rejects writes whose path implies an unknown type. See [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]].

## Ownership rules

| Directory | Owner | Mutability |
|---|---|---|
| `raw/` | User (or `dome capture`) | Immutable after creation. `RAW_IS_IMMUTABLE`. |
| `wiki/` | Dome (via Tools) | Mutable through `writeDocument`, `moveDocument`. |
| `notes/` | User | Dome reads, never writes. |
| `inbox/` | User writes; Dome's intake hooks consume | Writes by user are normal; Dome consumes (moves or deletes) during processing. |
| `index.md` | Dome dispatcher | Mutated only by `dispatcher.writeIndex`, invoked by the `auto-update-index` shipped-default hook. `writeDocument('index.md', ...)` rejects unconditionally per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]. |
| `log.md` | Dome dispatcher | Mutated only by `dispatcher.appendLogEntry`, called internally by the `appendLog` Tool. Append-only per [[wiki/invariants/LOG_IS_APPEND_ONLY]]; dispatcher-owned per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]. `writeDocument('log.md', ...)` rejects unconditionally. |
| `.dome/` | User (mostly) and shipped configs | User-authored; tools never mutate. |
| `.dome/extensions/<bundle>/` | Bundle author (SDK for first-party; user/community for vault-local installs) | Files in a loaded bundle are read at `openVault` and re-read on `dome doctor --repair`. Editing a bundle's `preamble.md` requires `--repair` to refresh AGENTS.md; editing a bundle's `hooks/*.yaml` takes effect on next `openVault`. The bundle directory is committed to git as part of the vault's identity. |
| `VISION.md`, `README.md` | User | Dome reads, never writes. |

## Vault discovery

A Vault is identified by the presence of `.dome/config.yaml`. `openVault(path)` walks up from `path` looking for the marker; CLI commands can be invoked from any subdirectory of a vault.

## Multi-vault

Dome is vault-agnostic: each process invocation targets exactly one vault root. Multi-vault is achieved by invoking the SDK / CLI / MCP server with different `--vault` arguments. There is no SDK-level "vault group" or cross-vault tool.

The user's working pattern of separate `~/vaults/work` and `~/vaults/personal` is honored structurally: two separate Vault instances, two separate MCP servers, two separate Claude Code configurations if desired.

## Related

- [[wiki/specs/sdk-surface]] — Vault and Document types.
- [[wiki/specs/page-schema]] — frontmatter contract per page type.
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — raw/ files cannot be modified.
- [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]] — wiki page type from subdirectory.
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — log.md append-only.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — markdown is canonical; nothing under `.dome/` is canonical knowledge.
