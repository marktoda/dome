---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# Vault layout

This spec is normative for the directory structure of a Dome vault.

## The vault root

A Dome vault is a git repository ([[wiki/invariants/VAULT_IS_GIT_REPO]]) containing:

```
<vault>/
  AGENTS.md           # canonical agent-orientation surface (per AGENTS_MD_IS_ORIENTATION_SURFACE)
  CLAUDE.md           # Claude Code shim pointing at AGENTS.md
  .dome/              # Dome configuration + derived state
  wiki/               # the compiled wiki (entities, concepts, dailies, syntheses, etc.)
  raw/                # immutable raw captures (per RAW_IS_IMMUTABLE)
  notes/              # user-authored content Dome reads but does not write
  inbox/              # ephemeral drop-zones for intake (per INBOX_IS_EPHEMERAL)
  log.md              # append-only projection of the run ledger (per LOG_IS_APPEND_ONLY)
  index.md            # projection of wiki/ catalogue
```

`wiki/`, `raw/`, `notes/`, and `inbox/` are top-level directories. `log.md` and `index.md` are top-level files. Additional top-level directories that aren't recognized by Dome (e.g., the project's `cohesive/` substrate residue, `scripts/`, or anything else) are tolerated as **external** — readable, never written by the engine.

## Category derivation

A document's category is derived from its path:

| Path prefix | Category |
|---|---|
| `raw/*` | `raw` |
| `wiki/*` | `wiki` |
| `notes/*` | `notes` |
| `inbox/*` | `inbox` |
| `log.md` | `log` |
| `index.md` | `index` |
| `.dome/*` | `config` |
| anything else | `external` |

The category is computed on demand from `document.path`; it is not stored. See [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] §"Derived state".

## `wiki/` — the compiled wiki

The wiki is partitioned by type. Each direct child of `wiki/` corresponds to a page type:

```
wiki/
  entities/        # people, products, teams, projects, organizations
  concepts/        # ideas, threads, themes
  sources/         # external citations Dome considers durable
  syntheses/       # higher-order claims built from other pages
  dailies/         # daily notes (from the dome.daily bundle)
  weeklies/        # weekly notes (from the dome.daily bundle)
  decisions/       # explicit decision artifacts
  ... (extension-contributed types)
```

The four default types — entities, concepts, sources, syntheses — are SDK-shipped. Additional types come from extension bundles (per [[wiki/specs/sdk-surface]] §"Extension bundles"). A vault declares which extension types it uses in `<vault>/.dome/page-types.yaml`'s `extensions:` block.

A page's *type* (singular) is the directory name in `wiki/` mapped through the `singularOf`/`pluralOf` helpers in `src/page-type.ts` (e.g., `wiki/entities/danny.md` → type `entity`). The frontmatter `type:` field carries the singular form.

## `raw/` — immutable raw captures

`raw/` contains source materials Dome treats as **definitive** for citation. Voice transcripts, meeting notes, research clippings, source-of-truth artifacts. Files in `raw/` are immutable after creation per [[wiki/invariants/RAW_IS_IMMUTABLE]]:

- `PatchEffect` targeting any `raw/<path>` is rejected by the broker.
- The `dome.markdown` adoption-phase processor emits a blocking diagnostic if any Proposal mutates a `raw/` file.
- `dome.intake`'s capture compilation writes *new* `wiki/` pages citing the raw; it never modifies the raw.

Raw files carry a `type:` frontmatter naming the capture source (e.g., `type: voice-capture`, `type: research-clip`). Subdirectory structure is convention, not contract — `raw/voice/`, `raw/meetings/`, `raw/clips/` are common but not required.

## `notes/` — user-authored content

`notes/` is user-owned. Dome **reads** notes; Dome does **not write** to notes. The asymmetry is by design — `notes/` is where the user keeps personal markdown that doesn't fit the wiki ontology. Lab books, personal journals, project memos.

`notes/` files do NOT emit `document.changed.notes.*` signals (the engine doesn't react to them). They emit only `vault.out-of-band-edit` for the watcher's drift-detection. The asymmetric ownership keeps the wiki / notes boundary clean.

## `inbox/` — ephemeral drop-zones

`inbox/` is where intake captures land before they're compiled into the wiki. Each subdirectory is an *intake bucket*:

```
inbox/
  raw/         # quick-capture target (shipped-default)
  voice/       # voice capture target (opt-in via voice-ingest activation)
  research/    # research-clip target (opt-in)
  clip/        # share-sheet target (opt-in)
  review/      # dome.lint report destination (NOT an intake)
  processed/   # where dome.intake archives successfully-processed captures
```

Files in `inbox/<bucket>/` (except `inbox/review/`) trigger the bucket's intake processor via `signal:file.created` + `pathPattern:"inbox/<bucket>/**"`. Pinned by [[wiki/invariants/INBOX_IS_EPHEMERAL]] — files are expected to move out (archived to `inbox/processed/` or compiled into `wiki/`) within minutes; lingering files are surfaced as diagnostics by `dome.lint`.

`inbox/review/` is the destination for `dome lint` reports. It is **not** an intake (no processor runs on writes to it). The user reviews lint reports there; applied findings produce engine commits annotating the report.

## `log.md` — append-only run-projection

`log.md` is a markdown projection of the run ledger ([[wiki/specs/run-ledger]]) — the human-readable view of "what did Dome do." Maintained by the `dome.log` adoption-phase processor with `owns.path: ["log.md"]` capability ([[wiki/specs/capabilities]] §"owns.path").

Append-only: `dome.log` adds entries; nothing rewrites entries. Pinned by [[wiki/invariants/LOG_IS_APPEND_ONLY]]. Reconstruction from the ledger is supported via the reserved-for-v1.x `dome doctor --repair` verb (per [[wiki/specs/cli]] §"dome doctor"); v1.0 callers may invoke the underlying processor directly via `dome run-processor dome.log:rebuild`.

## `index.md` — wiki catalogue

`index.md` is a markdown catalogue of every wiki page, partitioned by section. Maintained by the `dome.index` adoption-phase processor with `owns.path: ["index.md"]` capability.

Rebuilt by `dome rebuild` when stale. (The pre-recut `dome doctor --rebuild-index` flag is retired in favor of the unified `dome rebuild` scope plus, in v1.x, `dome rebuild --target index` if a scoped rebuild is needed.)

## `.dome/` — configuration + derived state

```
<vault>/.dome/
  config.yaml             # vault config — invariant enable/disable, bundle grants, engine knobs
  page-types.yaml         # default + extension page types declared for this vault
  extensions/             # OPTIONAL — vault-local third-party bundles
    <user-installed>/     # any user-installed bundle (directory copy)
                          # The SDK-shipped first-party bundles (dome.lint,
                          # dome.markdown, ...) live with the SDK and don't
                          # need to be copied here. See `extensions/` below.
  state/                  # derived operational state (gitignored)
    projection.db         # Bun.sqlite — facts, fts5, diagnostics, questions, schedule_cursors
    runs.db               # Bun.sqlite — run ledger
    outbox.db             # Bun.sqlite — external-action outbox
    quarantined.json      # processor quarantine state
    last-reconcile-mtime.txt   # marker file; mtime is the signal
```

### `config.yaml`

The single config file:

```yaml
vault:
  mode: local              # v1; "hosted" reserved for v1.5
  branch: main             # active source branch

invariants:
  RAW_IS_IMMUTABLE: enabled         # axioms always enabled; declaration is informational
  ALL_MUTATION_GOES_THROUGH_ADOPTION: enabled
  INBOX_IS_EPHEMERAL: enabled
  # ... full list per src/types.ts INVARIANTS

extensions:
  dome.markdown: { enabled: true,  grants: { patch.auto: ["**"] } }
  dome.index:    { enabled: true,  grants: { owns.path: ["index.md"], patch.auto: ["index.md"] } }
  dome.log:      { enabled: true,  grants: { owns.path: ["log.md"], patch.auto: ["log.md"] } }
  dome.links:    { enabled: true,  grants: { patch.propose: ["wiki/**"] } }
  dome.intake:   { enabled: true,  grants: { model.invoke: true, patch.auto: ["wiki/generated/**", "inbox/processed/**"] } }
  dome.daily:    { enabled: true,  grants: { patch.auto: ["wiki/dailies/**", "wiki/weeklies/**"] } }
  dome.lint:     { enabled: true,  grants: { patch.propose: ["**"] } }
  dome.search:   { enabled: true,  grants: { graph.write: ["dome.search"] } }
  dome.migrate:  { enabled: true,  grants: { patch.auto: ["**"] } }

engine:
  max_iterations: 100             # MAX_ITER for the fixed-point loop
  inbox_stale_age_hours: 168      # diagnostic threshold for INBOX_IS_EPHEMERAL
  git:
    auto_commit_closures: true    # whether closure commits land automatically

ledger:
  retention_days: null            # null = forever; set a number to enable pruning
  retention_failed_runs_days: null
```

### `page-types.yaml`

```yaml
defaults:
  - entity
  - concept
  - source
  - synthesis

extensions:
  - name: daily
    frontmatter_extras: { recurrence: required }
  - name: weekly
    frontmatter_extras: { recurrence: required }
```

### `extensions/`

Each `<vault>/.dome/extensions/<bundle>/` is a bundle directory per [[wiki/specs/sdk-surface]] §"Bundle directory shape". The SDK-shipped first-party `dome.*` bundles do **not** live here in v1.0 — they ship with the SDK at `<SDK>/assets/extensions/` and are resolved at runtime via `resolveShippedBundlesRoot()` (the default `--bundles-root` for every CLI command). The vault carries activations + grants in `.dome/config.yaml`; the bundle code is the SDK's responsibility.

`.dome/extensions/` is therefore **optional** and used only for vault-local overrides: a third-party bundle the user installs, or a customized version of a shipped first-party bundle. Install by creating the bundle directory under `.dome/extensions/<bundle-id>/` and passing `--bundles-root .dome/extensions` to the CLI commands. Multi-root resolution (merging the SDK's shipped bundles with a vault-local set in one runtime) is a v1.x polish; v1.0 picks exactly one root.

### Derived operational state under `.dome/state/`

Gitignored. Rebuildable. Three SQLite files plus markers:

- `projection.db` — see [[wiki/specs/projection-store]].
- `runs.db` — see [[wiki/specs/run-ledger]].
- `outbox.db` — see [[wiki/specs/projection-store]] §"Outbox".
- `quarantined.json` — processor-quarantine state (carries forward from v0.5; persisted via the engine's quarantine-store helper).
- `last-reconcile-mtime.txt` — mtime-only marker; consumed today by `dome status` (drift-state surface) and in v1.x by the planned `dome show drift-age` subject. The pre-recut `dome doctor --time-since-reconcile` flag is retired.

Per [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]], deleting any of `.dome/state/` files and running `dome rebuild` (for projection.db) or restarting the daemon (for runs.db and outbox.db) reconverges. The outbox is the exception — wiping `outbox.db` loses pending external actions; users should not delete it, only the projection.

## Git repository structure

The vault IS the git repository. There is no separate `.dome.git` directory or alternate VCS:

- `<vault>/.git/` — git's internal storage.
- `<vault>/.gitignore` — engine-managed; ignores `.dome/state/` and OS metadata.
- `<vault>/refs/dome/adopted/<branch>` (git ref) — the adopted cursor per [[wiki/specs/adoption]].

Commits in the vault fall into two classes:

| Class | Identification | Examples |
|---|---|---|
| **User commits** | No `Dome-Run:` trailer | `git commit -m "..."` from any harness or shell |
| **Engine commits** | Carry the four Dome-* trailers | Closure commits; init scaffold commits |

`git log --grep="^Dome-Run:"` returns engine history; `git log --invert-grep --grep="^Dome-Run:"` returns user history.

## Ownership rules

The capability broker enforces ownership. Default rules:

| Path | Owner |
|---|---|
| `index.md` | `dome.index` (via `owns.path`) |
| `log.md` | `dome.log` (via `owns.path`) |
| `raw/**` | nobody — immutable per [[wiki/invariants/RAW_IS_IMMUTABLE]] |
| `wiki/dailies/**`, `wiki/weeklies/**` | `dome.daily` (via `patch.auto`) |
| `wiki/generated/intake/**` | `dome.intake` (via `patch.auto`) |
| `inbox/processed/**` | `dome.intake` (via `patch.auto`) |
| `wiki/<type>/**` (general) | open — any processor with `patch.auto: ["wiki/**"]` |
| `notes/**` | user only — engine never writes here |

Plugin / third-party bundles cannot grant themselves `owns.path` on shipped-default paths (`index.md`, `log.md`). The broker rejects such grants at config-load time.

## Why this layout

Four properties make the layout self-defending:

1. **Category by path.** Adding a new page type doesn't require schema work — create `wiki/<plural>/`, declare in `page-types.yaml extensions:`, write a processor that handles the type's signals.
2. **`raw/` immutability is structural.** Pinned by RAW_IS_IMMUTABLE; broker refuses; dome.markdown emits blocking diagnostic.
3. **`.dome/state/` is wipeable.** Anything Dome derives can be rebuilt from markdown + git. The user can `rm -rf .dome/state/` and the vault recovers.
4. **`notes/` asymmetry keeps the wiki clean.** User-authored prose stays in notes; the wiki ontology stays curated by processors.

## Related

- [[wiki/specs/adoption]] — adopted ref under `refs/dome/`
- [[wiki/specs/projection-store]] — SQLite files under `.dome/state/`
- [[wiki/specs/run-ledger]] — `runs.db` under `.dome/state/`
- [[wiki/specs/page-schema]] — frontmatter contract per page type
- [[wiki/specs/sdk-surface]] §"Extension bundles" — `.dome/extensions/<bundle>/` shape
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — derived state is rebuildable
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — the vault root is a git repo
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — inbox bucket files are expected to move
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — raw files cannot be patched
