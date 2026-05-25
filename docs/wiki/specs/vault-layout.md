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
  inbox/                # (opt-in) drop-zone directories whose writes trigger hooks
    <bucket>/           # only directories the vault has activated (intake-raw, intake-voice, etc.)
                        # not pre-created by dome init
  .dome/                # vault-internal configuration and extensions
    page-types.yaml     # allowed page types: defaults + extensions
    config.yaml         # vault configuration (invariant overrides, hook settings, etc.)
    prompts/            # vault-local prompt overrides
    hooks/              # vault-local hooks: *.ts (programmatic) and *.yaml (declarative)
    tools/              # vault-local tool additions (rarely used)
    cli/                # vault-local CLI command additions (rarely used)
```

`dome init` creates the tier-1 axiom structure (vault root + raw/ + notes/ + wiki/ defaults + .dome/). `inbox/<bucket>/` directories exist only when the vault has activated the corresponding intake hook template — see [[wiki/specs/hooks]] §"Opt-in intake patterns."

## Category derivation

A Document's category is derived from the top-level directory in its `path`:

| Path prefix | Category |
|---|---|
| `raw/...` | `raw` |
| `wiki/...` | `wiki` |
| `notes/...` | `notes` |
| `inbox/...` | `inbox` |
| `log.md` | `log` |
| `index.md` | `index` |
| `.dome/...` | `config` |
| (other vault-root files) | `notes` (default) |

The category determines mutability and which Tool may write to it. See [[wiki/matrices/tool-invariant-enforcement]] and [[wiki/invariants/RAW_IS_IMMUTABLE]].

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

`writePage` rejects writes whose path implies an unknown type. See [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]].

## Ownership rules

| Directory | Owner | Mutability |
|---|---|---|
| `raw/` | User (or `dome capture`) | Immutable after creation. `RAW_IS_IMMUTABLE`. |
| `wiki/` | Dome (via Tools) | Mutable through `writePage`, `moveDocument`. |
| `notes/` | User | Dome reads, never writes. |
| `inbox/` | User writes; Dome's intake hooks consume | Writes by user are normal; Dome consumes (moves or deletes) during processing. |
| `index.md` | Dome (via `updateIndex`) | Mutable through one Tool only. |
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
