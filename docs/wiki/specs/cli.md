---
type: spec
created: 2026-05-27T00:00:00.000Z
updated: 2026-05-29T00:00:00.000Z
sources:
  - '[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]'
  - '[[v1]]'
---

# CLI

This spec is normative for Dome's command-line interface. The CLI is the
shipped v1 protocol adapter. It routes through the runtime directly today and
should converge with the planned [[wiki/specs/sdk-surface]] §"AbstractSurface"
for reads and view commands once that boundary lands, while keeping CLI-only
engine-control verbs such as `sync`, `serve`, and `rebuild`.

## The CLI surface

```text
dome init [path]                Initialize a new vault.
dome sync [--json] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]
                                Catch-up: construct Proposal from working-tree HEAD; adopt.
dome status [--json]            Vault health + content dashboard.
dome today [--date <YYYY-MM-DD>] [--json]
                                Source-backed daily task/followup surface.
dome prep [--date <YYYY-MM-DD>] [--limit <n>] [--json]
                                Source-backed daily planning packet.
dome agenda <person-or-topic> [--date <YYYY-MM-DD>] [--limit <n>] [--json]
                                Source-backed agenda for a person or topic.
dome query <text> [--category <c>] [--type <t>] [--limit <n>] [--json]
                                FTS + structured query against adopted state.
dome lint [--fail-on <severity>] [--json]
                                Adopted-state hygiene report.
dome export-context <topic> [--limit <n>] [--json]
                                Portable source-backed context packet.
dome run <name> [--json] [-- <processor flags>]
                                Invoke a command-triggered view processor.
dome rebuild                    Wipe and rebuild projection store from adopted commit.
dome inspect <subject> [--limit <n>] [--json]
                                Read-only view over the operational substrate.
                                Subjects: runs, diagnostics, questions, outbox, quarantine.
dome doctor [--json] [--repair] [--orphan-threshold-ms <n>]
                                Run engine-substrate health checks; --repair is
                                reserved for answer-mediated mitigations.
dome answer <question-id> [<value>]
                                Resolve an engine-raised QuestionEffect from
                                the user-decision channel.
dome serve [--vault <path>] [--poll-interval-ms <n>] [-v|--verbose]
           [--filter-processor <glob>] [-q|--quiet]
                                Run the local compiler host. Polls refs/heads/<branch>
                                every 500ms; constructs a manual Proposal and adopts on drift.
```

The CLI is the user-facing primary surface in v1. The implemented commands above map to one of:

- **Adoption catch-up:** `dome sync` — the Git-native catch-up path that triggers an adoption run for already-committed draft state.
- **Recall and dashboards:** `dome query`, `dome lint`, `dome export-context`, `dome today`, `dome prep`, `dome agenda`, `dome status`, `dome inspect` — read paths. `dome query`, `dome lint`, `dome export-context`, `dome today`, `dome prep`, and `dome agenda` route through the shipped view-command boundary today and should map to `AbstractSurface.query` / command views once that planned boundary lands; `dome status` is the compact local dashboard over git cursor, content analytics, and operational counts; `dome inspect` is a thin read over the operational state stores (projection / ledger / outbox / quarantine).
- **View-phase commands:** `dome run <name>` plus dedicated wrappers such as `dome query`, `dome lint`, `dome export-context`, `dome today`, `dome prep`, and `dome agenda` — command-triggered view-phase processors invoked through the shared view-command boundary.
- **Engine control:** `dome rebuild`, `dome doctor`, `dome answer`, `dome serve` — engine-substrate operations exposed only on the CLI surface. The current implementation records `dome answer` decisions, dispatches matching garden-phase answer handlers, renders probe-only `dome doctor` findings for failed outbox rows, orphan runs, and quarantined processors, and ships first-party `dome.health` recovery loops for failed outbox rows, quarantined processors, and orphaned running rows. See [[wiki/syntheses/v1-claude-code-vault-plan]].
- **Lifecycle:** `dome init` — vault construction. Schema migration is currently handled by storage open/rebuild paths; a dedicated `dome migrate` remains a v1.x roadmap item.

Planned dedicated view aliases such as `dome stats` are not Commander bindings
yet. Until they ship, their processors are invoked through `dome run
<command-name>` when present.

The `dome submit` command is **retired in v1.0** (Phase 11a demolition). It was the wrong shape: the canonical client-to-engine write path is plain `git commit`, observed by the local compiler host (`dome serve`). For a one-shot catch-up (the host isn't running and the user wants the current working tree adopted), use `dome sync`. The `dome reconcile` deprecated alias from v0.5+phase1+phase3 is **also retired in v1.** Callers see "unknown command" and a pointer to `dome sync`.

## CLI implementation

The CLI parser and help surface are owned by Commander.js in
`src/cli/index.ts`. Dome does not maintain a hand-rolled argv parser:
Commander owns subcommand routing, `-h` / `--help`, unknown-option
errors, argument arity, and usage text. Command modules expose typed
option-object handlers (`runStatus({ vault, json })`, etc.) so tests and
future adapters can invoke behavior directly without constructing
Commander objects.

The one deliberate exception is `dome run <name> -- <processor flags>` /
`dome run <name> --flag value`: view processors may define extension-
specific command arguments that the core CLI cannot know ahead of time.
The Commander binding for `dome run` allows unknown options and passes
those opaque flags through to `ctx.input.commandArgs.flags`; all shipped
first-party commands should prefer explicit Commander options.

Dedicated wrappers over shipped view processors (`dome query`, `dome lint`,
`dome export-context`, `dome today`, `dome prep`, and `dome agenda`) also validate the
returned `ViewEffect` boundary. Each wrapper expects exactly one view with
the canonical effect `name` and structured `schema` for that command before
rendering. `dome run` remains the generic extension escape hatch and renders
the processor's own view payloads without imposing a first-party schema.

## Per-command specs

### `dome init [path] [--refresh-config] [--refresh-instructions]`

Creates a new Dome vault at `<path>` (defaults to `.`). Phase 11f
hotfix: `dome init` no longer copies the shipped first-party bundles
into the vault. They live with the SDK at `<SDK>/assets/extensions/`
and are resolved at runtime via `resolveShippedBundlesRoot()` (the
default `--bundles-root` for every CLI command). Per [[wiki/specs/vault-layout]]
§"`extensions/`" and docs/v1.md §10.1, the vault carries activations +
grants in `.dome/config.yaml`; the bundle code itself doesn't need to
be copied into every vault.

The shipped initialization steps:

1. Initializes a git repository if one doesn't exist (`git init` is
   idempotent — a no-op when `.git/` already exists).
2. Creates the directory scaffold: `wiki/`, `.dome/state/`. (The
   `raw/`, `inbox/raw/`, `notes/` dirs are created lazily by the
   processors that write into them; pre-creating them is a v1.1 polish
   once the intake / capture surfaces ship. `.dome/extensions/` is not
   created — the shipped bundles live with the SDK; users wanting
   vault-local third-party bundles create the directory themselves.)
3. Writes `<vault>/.dome/config.yaml` from a shipped default (extension
   activation + engine settings). First-write-only by default.
   `--refresh-config` is an explicit maintenance path for old or hand-edited
   first-party configs: it adds missing first-party default bundle stanzas and
   fills missing first-party default grant keys for already enabled first-party
   bundles while preserving existing grant values, explicitly disabled bundles,
   and third-party bundle config. When it changes the file, it rewrites the YAML
   into normalized form so stale comments from older generated configs do not
   contradict the active grants.
4. Writes `<vault>/.gitignore` (ignores `.dome/state/` per
   [[wiki/specs/vault-layout]] §"Git repository structure"). First-write-only.
5. Writes `<vault>/AGENTS.md` from the shipped orientation template
   (per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]]) and
   `<vault>/CLAUDE.md` as a small Claude Code shim importing `AGENTS.md`.
   Claude Code reads `CLAUDE.md`, so the shim is part of the v1 boot
   path rather than polish. First-write-only — re-runs preserve any
   user-prose section the vault owner added. `--refresh-instructions` is an
   explicit maintenance path for old orientation files: it adds the managed
   AGENTS user-prose delimiters when missing and prepends the `@AGENTS.md`
   shim to CLAUDE.md when missing, preserving existing file content.
6. Creates an initial scaffold commit (`dome init: initial scaffold`)
   staging `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and
   `.dome/config.yaml`. Skipped if HEAD already resolves (re-init on a
   vault with commits is a
   no-op for this step).

Deferred to v1.1:
- `.dome/page-types.yaml` is not scaffolded by default. The page-type
  substrate ships today through built-in and bundle-contributed page types;
  this vault-local file remains an optional extension point for custom
  frontmatter schemas.
- The initial `dome sync` to produce `refs/dome/adopted/main` — the
  user runs `dome sync` (or `dome serve`) manually as their next step;
  the adopted-ref substrate initializes on first sync.

Installing a third-party bundle: create
`<vault>/.dome/extensions/<bundle-id>/` and pass
`--bundles-root <vault>/.dome/extensions` to the CLI commands. The
default `--bundles-root` (the SDK's shipped first-party bundles) does
not need to be passed explicitly. Multi-root resolution (merging the
SDK's shipped bundles with a vault-local third-party set in one
runtime) is a v1.x polish.

Each step prints a one-line outcome (`created`, `updated`, or `skipped
(already present)`); idempotent re-runs surface as all-skipped no-ops.

Exit codes: 0 on success (including idempotent re-runs); 1 on
unexpected I/O failure; 64 (EX_USAGE) on malformed path argument.

### `dome sync [--vault <path>] [--bundles-root <path>] [--json] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]`

The one-shot catch-up: detect drift between the working-tree HEAD and `refs/dome/adopted/<branch>`, construct a `manual`-source Proposal, run it through the engine's adoption loop, print the result, exit. This is the manual trigger for users who don't want a `dome serve` compiler host running continuously.

Composition (v1.0):

1. Resolve `vaultPath` (default cwd) and `bundlesRoot` (default SDK-shipped `assets/extensions/` via `resolveShippedBundlesRoot()`; optional override to `<vaultPath>/.dome/extensions` for vault-local bundles).
2. Inspect drift via the shared `detectDrift` helper (same code path `dome serve` polls in a loop).
3. Branch on drift outcome:
   - **detached HEAD** → exit 64 (EX_USAGE) with a clear stderr message.
   - **no commits** → exit 64 with a stderr message asking for an initial commit.
   - **diverged** → refuse before opening the adoption loop because the adopted ref is not an ancestor of HEAD; print recovery guidance and exit 1.
   - **in-sync** → open the runtime, acquire the branch-level compiler-host lock, run one operational-work pump against the adopted commit (due schedule triggers, durable jobs, and outbox rows already pending before the pump started), print `dome sync: already in sync (<head> on <branch>)`, exit 0.
   - **drift** → open the runtime, acquire the branch-level compiler-host lock, run `runOneAdoption`, then after a successful adoption run the same operational-work pump against the new adopted commit; print the result block (or `--json` payload), exit 0 (adopted) or 1 (blocked).
   - **busy** → another Dome host already holds the branch-level compiler-host lock; print a retryable busy message, exit 75.
4. Close the runtime on the way out.

`--json` emits a single JSON object on stdout suitable for cross-tool consumption:

```json
{"status":"adopted","branch":"main","base":"abc...","head":"def...","adoptedRef":"def...","iterations":1,"closureCommit":null,"diagnostics":[]}
```

`status` is one of `"adopted" | "blocked" | "in-sync" | "busy" | "error"`. The `error` field is present on `"busy"` and error variants such as detached HEAD, no commits, runtime-open failure, or adopted-ref divergence.
For `"in-sync"`, `diagnostics` contains diagnostics produced by the operational-work pump, if any; no adoption diagnostics are synthesized because no adoption ran.

`--quiet` suppresses non-error human-readable text for adopted / in-sync
outcomes. It does not suppress `--json`, usage errors, blocked-adoption
diagnostics, or compiler-host busy messages. `--quiet` and `--verbose` are
mutually exclusive.

`--verbose` prints typed adoption-loop progress events. When
`--filter-processor <glob>` is present, verbose output includes only matching
per-processor result lines such as `dome.markdown.*`; iteration scaffolding is
suppressed so filtered logs stay focused.

The `--force-advance` flag is **deferred** in v1.0. The adopted-ref substrate's fast-forward-only check is in place; the bypass surface lands when the adopted-ref-divergence recovery flow is wired end-to-end (a v1.1 polish). Until then, a divergent HEAD is detected by the shared compiler-host drift boundary before any Proposal is constructed, and the operator resolves manually.

Exit codes: 0 on adopted / in-sync; 1 on blocked, adopted-ref divergence, or runtime-open failure; 64 (EX_USAGE) on detached HEAD or no commits; 75 (EX_TEMPFAIL) when another compiler host holds the branch lock.

See [[wiki/specs/adoption]] §"`dome sync`" for the broader normative description.

### `dome status [--json]`

The health pulse for a vault. It is read-only and cheap enough for an
agent or user to run at session start/end. Status intentionally combines
the old "am I adopted?" pulse with cheap vault analytics so Claude Code
and a human operator get one useful first glance, not two separate
commands. Text mode renders a compact dashboard:

```text
DOME status
vault     /Users/mark/vaults/work
git       branch main | head 41a98c2 | adopted 41a98c2 | sync ok | pending 0
draft     0 modified | 0 untracked
content   1,247 pages | wiki 1,247 | notes 87 | inbox 14 | links 8,143 | raw 412 files (2.4 MB)
engine    last sync 2026-05-28T12:34:56.000Z | pending 0 | failed 0 | serve running
health    diagnostics 0 | questions 0 | outbox 2 pending / 0 failed | quarantine 0
```

`--json` emits the same stable keys for agent consumption:

```json
{"vault":"/Users/mark/vaults/work","branch":"main","head":"41a98c2...","adopted":"41a98c2...","sync_needed":false,"pending_commits":0,"adopted_diverged":false,"dirty_modified":0,"dirty_untracked":0,"content_pages":1247,"wiki_pages":1247,"notes_pages":87,"inbox_pages":14,"wikilinks":8143,"raw_files":412,"raw_bytes":2516582,"last_sync":"2026-05-28T12:34:56.000Z","pending_runs":0,"failed_runs":0,"recent_processor_runs":[{"processor_id":"dome.daily.task-index","processor_version":"1.0.0","phase":"garden","latest_run_id":"run_...","latest_status":"succeeded","latest_started_at":"2026-05-28T12:34:56.000Z","latest_finished_at":"2026-05-28T12:34:56.140Z","latest_duration_ms":140,"recent_runs":3,"recent_problem_runs":0}],"serve_status":"running","serve_pid":12345,"serve_branch":"main","serve_updated_at":"2026-05-28T12:34:56.000Z","diagnostics":0,"questions":0,"outbox_pending":2,"outbox_failed":0,"quarantined":0}
```

`recent_processor_runs` is a bounded summary over the newest 100 run-ledger
rows, grouped by processor id. It is for status dashboards and agents that
need to spot the processor currently causing churn; `dome inspect runs`
remains the full audit surface.

The analytics are cheap first-glance counts, not a graph report:
markdown pages under `wiki/`, `notes/`, and `inbox/`; wikilink
occurrences in those markdown files; raw file count and bytes under
`raw/`; sync drift, adopted-ref divergence, and pending commit count for
adopted..HEAD when the adopted ref is initialized and ancestral to HEAD; and
dirty working-tree counts excluding rebuildable
`.dome/state/` files. The operational counts are pointers, not full
reports. `serve_status` is read from the foreground host heartbeat file and is
`running`, `stale`, or `off`; stale means the host did not exit cleanly or has
not refreshed its heartbeat within the host's configured cadence. Use
`dome inspect diagnostics`, `dome inspect questions`,
`dome inspect outbox`, or `dome inspect runs` for details. See
[[wiki/specs/adoption]] §"`dome status`" for the adopted-ref framing and
[[wiki/specs/foreground-compiler-workflow]] for the normal session pulse.

### `dome query <text> [--category <c>] [--type <t>] [--limit <n>] [--json]`

Invokes the `dome.search.query` view-phase processor against adopted-state
projections. The processor reads FTS rows and related facts through
`ctx.projection`; it does not read the working tree. Before dispatch, the
shared view-command boundary resolves the adopted commit and rebuilds
`projection.db` if the stored adopted commit, extension-set hash, or
processor-version hash is stale. Output (text mode):

```text
4 adopted-state match(es) for "platform ownership"

1. Platform Team Ownership (wiki/syntheses/platform-team-ownership.md)
   Atlas owns runtime; platform owns infrastructure boundaries...
   SourceRefs:
     - wiki/syntheses/platform-team-ownership.md:14-22 @ 41a98c2

2. 2026-05-23 (wiki/dailies/2026-05-23.md)
   Discussed platform ownership with Danny...
   SourceRefs:
     - wiki/dailies/2026-05-23.md:48-52 @ 41a98c2

(further matches truncated; --limit to show all)
```

`--json` emits the structured `dome.search.query/v1` payload. Every match
carries SourceRefs because the FTS rows are written from SearchDocumentEffect.

### `dome lint [--fail-on <severity>] [--json]`

Dedicated wrapper for the `dome.lint.report` view processor. It reads the
adopted-state diagnostic projection plus deterministic snapshot checks through
the normal view context; it does not scan the working tree and never mutates
state.

Default text output renders a compact report:

```text
DOME lint
status   pass | fail-on error
checked  1247 markdown files
issues   3 total | 0 block | 0 error | 3 warning | 0 info

Issues
  - [warning] dome.markdown.broken-wikilink: Broken wikilink: [[missing]]
    wiki/projects/platform.md:14-14 @ 41a98c2
```

`--fail-on` defines the exit threshold. Values are `info`, `warning`, `error`,
`block`, or `never`; omitted defaults to `error`, so warnings are visible
without making the command fail. `--json` emits the structured
`dome.lint.report/v1` payload with the same status, counts, checked-file
summary, issues, and SourceRefs.

### `dome export-context <topic> [--limit <n>] [--json]`

Dedicated wrapper for the `dome.search.export-context` view processor. It uses
the same adopted-state retrieval substrate as `dome query`, then renders a
portable markdown packet for another Claude session, review, or handoff.

Default text output is the markdown packet itself. It includes matching paths,
snippets, related facts, and SourceRefs. `--json` emits the structured
`dome.search.export-context/v1` payload, including the packet under
`markdown`.

### `dome run <name> [--json] [-- <processor flags>]`

Invokes the view-phase processor whose command trigger declares `<name>`.
The shared view-command boundary validates the adopted ref, opens the runtime,
rebuilds stale projections before read access, routes emitted effects through
the broker, records capability use in the run ledger, and renders returned
ViewEffects as JSON. Unknown flags after the command name are passed through
to `ctx.input.commandArgs.flags` so extension-defined view commands can add
their own option shapes without changing the core CLI parser.

Exit codes: 0 on success; 64 when no matching view processor exists or the
vault has no usable adopted ref; 1 on runtime or dispatch failure.

### `dome today [--date <YYYY-MM-DD>] [--json]`

Dedicated wrapper for the `dome.daily.today` view processor. The shared
view-command boundary validates the adopted ref, refreshes stale projections,
then invokes the extension-owned command trigger `today`.

Default text output renders:

- the target date and expected daily-note path,
- whether that daily note exists at the adopted ref,
- source-backed open tasks and followups from `dome.daily.open_task` /
  `dome.daily.followup` facts,
- unresolved `dome.daily.*` questions.

`--json` emits the structured `dome.daily.today/v1` payload. `--date` is for
reviewing another day and for deterministic tests; omitted means local today.

### `dome prep [--date <YYYY-MM-DD>] [--limit <n>] [--json]`

Dedicated wrapper for the `dome.daily.prep` view processor. It uses the same
source-backed daily action state as `dome today`, then renders a portable
planning packet for the target day.

Default text output is markdown:

- the target daily note path and whether it exists,
- counts for open tasks, followups, and daily questions,
- a prioritized "Start Here" section that lists followups first, unresolved
  daily questions second, and other open tasks third,
- bounded followup / task / question sections,
- SourceRefs for the backing daily note and extracted facts/questions.

`--limit` bounds each rendered section and the prioritized start list. `--json`
emits the structured `dome.daily.prep/v1` payload, including the markdown packet
under `markdown`. `--date` is for prepping a chosen day and for deterministic
tests; omitted means local today.

### `dome agenda <person-or-topic> [--date <YYYY-MM-DD>] [--limit <n>] [--json]`

Dedicated wrapper for the `dome.daily.agenda-with` view processor. It reuses
the same source-backed daily action state as `dome today` / `dome prep`, filters
open tasks, followups, and unresolved daily questions by the supplied person or
topic, and joins adopted-state search matches when `dome.search` has populated
the projection.

Default text output is markdown:

- the date context and daily note path,
- matching open agenda items with source labels,
- adopted-state context snippets for the person/topic,
- SourceRefs for the backing facts, questions, and search entries.

`--limit` bounds agenda items and context matches. `--json` emits the structured
`dome.daily.agenda-with/v1` payload, including the markdown packet under
`markdown`. `--date` provides daily-note context; omitted means local today.

### `dome rebuild`

Wipes `<vault>/.dome/state/projection.db` and rebuilds from the adopted commit per [[wiki/specs/projection-store]] §"Rebuild path". The run ledger (`runs.db`) and outbox (`outbox.db`) are preserved. Text output is intentionally terse:

```text
dome rebuild: rebuilding projection.db from adopted commit 41a98c2...
dome rebuild: done (234 files, 9 processors, 812 effects)
```

`--json` emits `{ status, branch, adopted, files, processors, effects }` on
success or `{ status: "error", branch, adopted, error }` on failure.

Exit codes: 0 on success; 1 on rebuild/runtime failure; 64 (EX_USAGE) on
detached HEAD or uninitialized adopted ref.

### `dome inspect <subject> [--limit <n>] [--json]`

Read-only view over the operational substrate. The command opens the
runtime (so the operational databases are initialized) but does not submit a
Proposal, does not invoke any processor, and does not mutate state.

Subjects (v1.0):

- `runs` — recent processor runs from `runs.db`.
- `diagnostics` — current unresolved diagnostics from
  `projection.db.diagnostics`, including compact SourceRef locations so Claude
  can jump directly to affected markdown.
- `questions` — durable questions from `projection.db.questions`, including
  row id, status, options, answer, timestamps, and idempotency key.
- `outbox` — pending / failed external actions from `outbox.db`.
- `quarantine` — quarantined processor triggers from processor execution state,
  including the `quarantine_id` generation token used for safe reset.

`--limit <n>` caps the row count (default 20). `--json` emits structured
rows for cross-tool consumption.

Exit codes: 0 on a clean read (including empty result sets); 1 on
runtime-open failure; 64 (EX_USAGE) on unknown subject or malformed
`--limit`.

**Two producers, one table.** The `diagnostics` subject surfaces rows
from both engine-emitted DiagnosticEffects (structural failures like
`adoption.detached-head`, `capability-downgrade-surprise`, `fixed-point.divergence`)
and processor-emitted DiagnosticEffects (content findings like
`dome.markdown.broken-wikilink`). Both ride the same channel per the
closed Effect taxonomy at [[wiki/specs/effects]] §"DiagnosticEffect";
the `processor_id` column today carries either a synthetic engine
producer id or a real processor id. A future `source` column proposal
makes this distinction queryable — see [[wiki/specs/projection-store]]
§"Tables — diagnostics".

Future subjects (v1.x): `cost`, `orphan-runs`, `recent-activity`,
`recent-processor-divergence`. Adding a subject is one new query
function + one case in the dispatcher; no new CLI surface per subject.

### `dome doctor [--json] [--repair]`

Engine-substrate **health check** verb. The current implementation is
probe-only and read-only: it reports failed/stuck outbox rows, orphan running
rows, quarantined processor triggers, projection cache drift, adopted-ref
divergence, instruction drift, operational schema mismatches, and enabled
processor capability kinds that are declared but not granted from
`src/engine/health.ts`.

**Current behavior.** `dome doctor` opens the runtime, collects a
`HealthReport`, prints a compact text report, and exits 0. `--json` emits the
same report with `status`, `summary`, and `findings`. `--repair` exits 64
because recovery mutations still belong to the answer-handler loop. The report
is not yet persisted as DiagnosticEffects.

**Target v1.x shape.** Health probes can become scheduled `dome.health`
processors that persist DiagnosticEffects for durable inspection, and the
doctor report can become a view-phase command processor over those rows. That
is an implementation target, not the current v1 command path.

**Why this isn't a kitchen-sink admin command.** Pre-recut, the spec
described `dome doctor` as a single verb covering reads (`--show`),
checks (`--check-all`), and per-substrate mutations (`--outbox-replay`,
`--reset-quarantined-processors`, `--repair`-as-bundle-recopy, etc.).
The recut splits these along their real seams:

- **Reads** → `dome inspect <subject>` (above).
- **Probes** → `dome doctor` (this section). The probes themselves are
  garden-phase processors; the verb is just the view-phase renderer.
- **Per-substrate mutations needing human input** → engine-emitted
  QuestionEffect → user runs `dome answer <id>` (below) → answer-handler
  processor in the `dome.health` bundle applies the mutation. No
  per-substrate verb-noun commands.
- **Auto-mitigations** (AGENTS.md template drift, projection schema
  rebuild, orphan-commit GC) → handled inline by garden-phase processors
  with no CLI surface; the engine just does them. Operational schema
  mismatches in `answers.db`, `outbox.db`, or `runs.db` are not
  auto-mitigated because those files are unrebuildable; `dome doctor`
  reports them before the runtime opens the DB for mutation.
- **Synchronization** (`--drain-processors`) → `dome wait` or absorbed
  into `dome status --wait-quiet`. Doesn't fit the engine-asks model
  because there's no decision; it's a "block until quiet" verb.

This collapses the v0.5 / pre-recut "doctor as admin grab-bag" into
three named surfaces (`inspect`, `doctor`, `answer`) plus the existing
processor substrate.

### `dome answer <question-id> [<value>]` *(required for complete v1 recovery)*

The universal **user-decision channel** for QuestionEffects the engine
has raised but cannot resolve autonomously.

**Why a single answer surface (not per-substrate verbs).** The engine
already has a primitive for "I need a human decision" — `QuestionEffect`
in the closed taxonomy at [[wiki/specs/effects]] §"QuestionEffect".
When operational substrate gets stuck (outbox row terminally failed,
processor quarantined, force-advance needed across a divergent
adopted ref), the natural pattern is:

1. **A scheduled garden-phase processor in `dome.health`** reads the relevant
   operational substrate through a scoped `ctx.operational` query view
  (for example failed outbox rows via `outbox.read` or quarantines via
  `quarantine.read`).
2. **That processor emits a `QuestionEffect`** with options (for example
   `["retry", "abandon"]`), an idempotency key that names the stuck row and
   failure instance, and `sourceRefs` pointing at the substrate row's origin.
3. **User runs `dome inspect questions`** to see pending questions.
4. **User runs `dome answer <question-id> retry`** to resolve.
5. **A second garden-phase processor in `dome.health`** declares an
   `answer` trigger bound to both the emitting question processor and the
   idempotency-key prefix, receives `{ question, answer }`, looks up the
   question's `idempotencyKey` → operational target, and emits the appropriate
   recovery effect to mutate the engine-owned operational state.

The CLI surface is one verb (`dome answer`); the per-substrate logic
lives in the `dome.health` bundle's answer-handler processors. Adding
a new operational mutation type is one new question-emitter + one
new answer-handler in the bundle; no new CLI command.

**Design (complete v1).** `<question-id>` is the question row's id (from
`dome inspect questions`). `<value>` is one of the question's options
(when `options` is set) or free-form text (when `options` is null).
Without `<value>`, `dome answer <question-id>` prints the question
and its options.

Answering writes the durable answer to `answers.db.question_answers`, updates
the current `projection.db.questions` row for inspect/query ergonomics, and
dispatches garden-phase processors with `answer` triggers. The relevant
answer-handler processor catches the answer event and applies the mutation
through normal Effect routing. Operational recovery answer handlers must match
the question's originating `processorId` as well as its idempotency-key prefix;
this prevents a third-party question emitter from invoking a first-party
handler that holds recovery capabilities.

**Current behavior.** `dome answer` looks up the row id, prints the question
when `<value>` is omitted, validates `<value>` against `options` when options
are present, records the answer, and dispatches matching garden-phase answer
handlers. Duplicate-detection content questions plus a fixture answer handler
are covered end-to-end by the harness.

Answer-handler dispatch is retryable from the durable answer record. The CLI
records the answer before dispatching handlers, marks handler dispatch
`handled` only after the handler pass completes, and re-dispatches an already
answered question when `answers.db.question_answers.handler_status` is not
`handled`. Projection rebuild preserves the answered state by replaying
`answers.db.question_answers` onto rebuilt question rows.

`dome.health` now ships the failed-outbox retry/abandon loop, quarantined
processor reset loop, and orphan-run fail loop as first-party processors.
All three use the same question/answer flow rather than hidden per-substrate
CLI verbs.

### `dome serve [--vault <path>] [--bundles-root <path>] [--poll-interval-ms <n>] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]`

Runs the local compiler host — the canonical write path per [[v1]] §13.2 ("Claude Code edits project notes"). The user commits markdown via `git commit` (directly or via their harness's native write tool); the host catches up by adopting the new HEAD.

Composition (v1.0):

1. `openVaultRuntime({vaultPath, bundlesRoot})` opens the operational databases (`projection.db`, `answers.db`, `outbox.db`, `runs.db`) and loads extension bundles from the resolved bundles root (SDK-shipped `assets/extensions/` by default; vault-local `.dome/extensions/` only when explicitly selected).
2. Resolves the initial branch via `getCurrentBranch`. A detached HEAD is a startup error (the adopted-ref substrate requires a branch).
3. Polls `refs/heads/<branch>` every `--poll-interval-ms <n>` (default 500ms). On each tick, compares HEAD to `refs/dome/adopted/<branch>`:
   - If the adopted ref is uninitialized: runs an empty-diff `(HEAD, HEAD)` adoption to initialize it.
   - If HEAD equals the adopted ref: no adoption work; quiet in-sync ticks may still run due operational work on the host's internal cadence.
   - Otherwise: constructs a `manual`-source Proposal via `makeManualProposal({base: adopted, head: HEAD, branch})` and routes it through the engine's `adopt()`.
4. Adoption runs; effects route through `buildSqliteSinks` (projection + outbox writes) + the engine's candidate-tree `applyPatch` sink. View delivery remains a placeholder sink in v1.0.
5. Every adoption or operational-work pump acquires the same branch-level compiler-host lock that `dome sync` uses. A second host does not race the first; it reports busy and retries on the next poll.
6. After an adoption finishes, `serve` checks drift again before sleeping. If HEAD moved while adoption was active, the next adoption starts immediately rather than waiting for the full poll interval. This coalesces stacked commits without overlapping compiler work.
7. The host also runs operational-work pumps while HEAD is already in sync, on a quiet internal cadence. This is how schedule triggers, durable jobs, and outbox retries that become due solely because time passed make progress in a quiet vault. Default output stays silent; `--verbose` may print counts.
8. The host refreshes `.dome/state/serve-heartbeat.json` so `dome status`
   can report whether the foreground compiler appears `running`, `stale`, or
   `off`. The heartbeat is observability only; the branch-level compiler-host
   lock remains the concurrency guard.
9. Stays running until SIGINT / SIGTERM; on shutdown, retryable in-flight
   outbox handler attempts receive the host cancellation signal and remain
   pending without consuming retry budget, then the host closes the runtime
   (releases the projection, answers, ledger, and outbox SQLite handles) and
   exits 0.

`--quiet` suppresses routine text output: startup banner, successful adoption
summaries, operational-work summaries, and shutdown line. It still reports
startup failures, detached-HEAD pauses, blocked adoption diagnostics, and
unexpected tick errors. `--quiet` and `--verbose` are mutually exclusive.

`--verbose` prints adoption-loop progress events. `--filter-processor <glob>`
narrows those verbose events to matching processor ids, for example
`dome serve --verbose --filter-processor 'dome.markdown.*'`. It filters only
observability output; it never changes which processors run.

The watcher mechanism is **poll-based** (not filesystem-event-based). Poll is simpler than `fs.watch` on `.git/refs/heads/<branch>`, requires no extra dependencies, and 500ms latency is invisible to a user committing markdown. The v0.5 chokidar-over-`wiki/` watcher was retired with the v1.0 substrate migration — adoption is keyed off git commits, not raw file writes, so the watch target is a ref (one file) rather than the whole vault subtree.

The scheduled-trigger dispatcher for garden processors is wired through the same runtime grant resolver as adoption. View processors are command-driven in v1 because scheduled views have no caller-owned delivery surface. There is no separate `serve --exclusive` flag in v1 because branch-level locking is always on. The `--mcp` toggle remains deferred to v1.1.

Exit codes: 0 on graceful shutdown; 1 on startup error (detached HEAD, runtime open failure, malformed `--poll-interval-ms`).

### Planned dedicated view aliases

`dome stats` and `dome migrate` are roadmap commands, not current Commander
bindings. The intended shape is:

- `dome stats` — richer vault analytics beyond the compact `dome status`
  dashboard.
- `dome migrate` — explicit vault/schema upgrade orchestration beyond the
  current open-time SQLite migration and projection rebuild paths.

Until these aliases ship, command-triggered view processors are invoked via
`dome run <command-name>`.

## Adding a new command

The "Adding a new command" recipe parallels [[wiki/specs/sdk-surface]] §"Adding a processor" — CLI commands are command-triggered view-phase processors. A generic `dome run <name>` command needs three edits:

1. **The processor file** at `assets/extensions/<bundle>/processors/<command-name>.ts` exporting `defineProcessorImplementation({ run })`.
2. **The manifest entry** in the bundle's `manifest.yaml` declaring `phase: "view"` and `triggers: [{ kind: "command", name: "<command-name>" }]`.
3. **An end-to-end test** at `tests/harness/scenarios/cli-surface/<command>.scenario.test.ts` exercising `dome run <command-name>` against a fixture vault.

A dedicated `dome <name>` Commander binding is a fourth edit when the command
has user-facing ergonomics that justify first-class flags, help text, or text
rendering.

The CLI Commander layer is the thin protocol adapter; the work happens in the processor. Adding a command that does *not* need a dedicated `dome <name>` Commander binding is three edits — register the processor and invoke it via `dome run <command-name>`. A future `AbstractSurface` adapter should reuse the same shared dispatch boundary so dedicated view commands and generic command invocations inherit adopted-ref validation, projection freshness rebuilds, effect routing, and ledger recording consistently.

Planned substrate scaffold:
- A future CLI-shell-shape test should enumerate command-triggered processors in `assets/extensions/dome.*/processors/` and assert each has either a Commander binding in `src/cli/index.ts` or a documented `dome run` invocation in `cli.md`.

## Why the CLI surface is rich (not minimal)

The CLI is the primary v1 surface for agentic harnesses. Stable operational
verbs (`sync`, `status`, `query`, `inspect`, `doctor`, `answer`, `rebuild`,
`serve`) are named CLI commands. Extension-defined view commands can start
behind `dome run <name>` and graduate to dedicated aliases once their workflow
deserves first-class help text, flags, and text rendering. This keeps the core
surface small while leaving a clean path to richer named commands.

The planned MCP server (per [[wiki/specs/mcp-surface]]) is the alternative for harnesses that prefer typed read/query routing; command-style views would be reachable through `dome.run_command`. Adoption catch-up remains CLI/git-native in v1.0.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the planned AbstractSurface this adapter should converge with.
- [[wiki/specs/harnesses]] — when the CLI vs MCP earns its keep.
- [[wiki/specs/adoption]] — what `dome sync` / `dome status` consult.
- [[wiki/specs/processors]] — view-phase command processors.
- [[wiki/matrices/protocol-adapter]] — CLI as one row in the adapter map.
