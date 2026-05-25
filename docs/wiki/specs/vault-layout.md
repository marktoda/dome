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
    <other-buckets>/    # opt-in: voice/, research/, clip/, review/ — created when the user activates the corresponding intake
  .dome/                # vault-internal configuration and extensions
    page-types.yaml     # allowed page types: defaults + extensions
    config.yaml         # vault configuration (invariant overrides, hook settings, etc.)
    prompts/            # vault-local prompt overrides
    hooks/              # vault-local hooks: *.ts (programmatic) and *.yaml (declarative)
    tools/              # vault-local tool additions (rarely used)
    cli/                # vault-local CLI command additions (rarely used)
    state/              # derived: scheduled.json, last-reconciled-sha.txt (gitignored)
  .git/                 # git repository (axiom: every Dome vault is a git repo)
  .gitignore            # excludes .dome/state/ (per-machine operational state)
```

`dome init` creates the axiom structure (vault root + raw/ + notes/ + wiki/ defaults + .dome/) AND `inbox/raw/` (the shipped-default capture bucket) AND `.git/` via `git init`. Additional `inbox/<bucket>/` directories (`voice/`, `research/`, `clip/`, `review/`) exist only when the vault activates the corresponding intake hook template — see [[wiki/specs/hooks]] §"Opt-in intake patterns."

### Git repository structure

Every Dome vault is a git repository per [[wiki/invariants/VAULT_IS_GIT_REPO]]. The `.git/` directory at vault root is treated as `category: external` by Dome's tools (Dome never touches it; it's not enumerated; it's not part of any wiki).

What gets committed to git:

- `VISION.md`, `README.md`, `index.md`, `log.md` — committed.
- `raw/`, `notes/`, `wiki/`, `inbox/` — all committed. Reconciliation works against committed AND uncommitted state.
- `.dome/page-types.yaml`, `.dome/config.yaml`, `.dome/prompts/`, `.dome/hooks/`, `.dome/tools/`, `.dome/cli/` — committed (these are the vault's identity).
- `.dome/state/` — **gitignored** (per-machine operational state: `last-reconciled-sha.txt` + `scheduled.json`).

### Derived operational state under `.dome/`

| Path | Role | If deleted |
|---|---|---|
| `.dome/state/last-reconciled-sha.txt` | The SHA at which the last `dome reconcile` completed | Next reconcile treats every file as changed; idempotent so safe |
| `.dome/state/scheduled.json` | Last-fire timestamps for scheduled hooks | Next reconcile fires every scheduled hook once |

Both files are derived state: deleting them doesn't lose canonical knowledge; deleting them just causes the next reconciliation to do more work. The vault's markdown content (under `wiki/`, `raw/`, etc.) is the only canonical surface.

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
| `index.md` | Dome (via `writeDocument` invoked by the `auto-update-index` hook) | Mutated only through the auto-update-index shipped-default hook. |
| `log.md` | Dome (via `appendLog`) | Append-only. `LOG_IS_APPEND_ONLY`. |
| `.dome/` | User (mostly) and shipped configs | User-authored; tools never mutate. |
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
