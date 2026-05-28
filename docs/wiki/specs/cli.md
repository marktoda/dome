---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# CLI

This spec is normative for Dome's command-line interface. The CLI is **one protocol adapter** over [[wiki/specs/sdk-surface]] §"AbstractSurface" for reads and view commands, plus CLI-only engine-control verbs such as `sync`, `serve`, and `rebuild`.

## The CLI surface

```text
dome init [path]                Initialize a new vault.
dome sync [--force-advance]     Catch-up: construct Proposal from working-tree HEAD; adopt.
dome status [--json]            Read-only adoption snapshot.
dome query <text> [--filter ...] [--require-evidence]
                                FTS + structured query against adopted state.
dome lint [--apply <id>] [--report-only]
                                Run dome.lint; write report; optionally apply a finding.
dome rebuild                    Wipe and rebuild projection store from adopted commit.
dome stats                      Vault size / processor counts / ledger summary.
dome inspect <subject> [--limit <n>] [--json]
                                Read-only view over the operational substrate.
                                Subjects: runs, diagnostics, questions, outbox.
dome doctor [--repair]          (reserved for v1.x) Run engine-substrate
                                health checks; emit Diagnostics; --repair
                                applies safe mitigations.
dome answer <question-id> [<value>]
                                (reserved for v1.x) Resolve an engine-raised
                                QuestionEffect from the user-decision channel.
dome serve [--vault <path>] [--poll-interval-ms <n>]
                                Run the commit-watcher daemon. Polls refs/heads/<branch>
                                every 500ms; constructs a manual Proposal and adopts on drift.
dome export-context <topic>     Render a portable context packet for cross-AI handoff.
dome migrate                    Upgrade vault for newer SDK schema.
dome run-processor <id> [--args ...]
                                Invoke a specific command-triggered processor by id.
```

The CLI is the user-facing primary surface in v1. Every command above maps to one of:

- **Adoption catch-up:** `dome sync` — the Git-native catch-up path that triggers an adoption run for already-committed draft state.
- **Recall:** `dome query`, `dome status`, `dome inspect` — read paths. `dome query` / `dome status` route through `AbstractSurface.query` / `getAdoptionStatus`; `dome inspect` is a thin read over the three operational sqlite databases (projection / ledger / outbox).
- **View-phase commands:** `dome lint`, `dome stats`, `dome export-context` — command-triggered view-phase processors invoked via `AbstractSurface.commands`.
- **Engine control:** `dome rebuild`, `dome doctor`, `dome answer`, `dome serve` — engine-substrate operations exposed only on the CLI surface. `dome doctor` and `dome answer` are **reserved for v1.x** per §"dome doctor" and §"dome answer" below; only `dome rebuild` and `dome serve` ship in v1.0.
- **Lifecycle:** `dome init`, `dome migrate` — vault construction and schema upgrade, exposed only on the CLI.

The `dome submit` command is **retired in v1.0** (Phase 11a demolition). It was the wrong shape: the canonical client-to-engine write path is plain `git commit`, observed by the engine's watcher daemon (`dome serve`). For a one-shot catch-up (the daemon isn't running and the user wants the current working tree adopted), use `dome sync`. The `dome reconcile` deprecated alias from v0.5+phase1+phase3 is **also retired in v1.** Callers see "unknown command" and a pointer to `dome sync`.

## Per-command specs

### `dome init [path]`

Creates a new Dome vault at `<path>` (defaults to `.`). Phase 11f
hotfix: `dome init` no longer copies the shipped first-party bundles
into the vault. They live with the SDK at `<SDK>/assets/extensions/`
and are resolved at runtime via `resolveShippedBundlesRoot()` (the
default `--bundles-root` for every CLI command). Per [[wiki/specs/vault-layout]]
§"`extensions/`" and docs/v1.md §10.1, the vault carries activations +
grants in `.dome/config.yaml`; the bundle code itself doesn't need to
be copied into every vault.

The shipped five steps:

1. Initializes a git repository if one doesn't exist (`git init` is
   idempotent — a no-op when `.git/` already exists).
2. Creates the directory scaffold: `wiki/`, `.dome/state/`. (The
   `raw/`, `inbox/raw/`, `notes/` dirs are created lazily by the
   processors that write into them; pre-creating them is a v1.1 polish
   once the intake / capture surfaces ship. `.dome/extensions/` is not
   created — the shipped bundles live with the SDK; users wanting
   vault-local third-party bundles create the directory themselves.)
3. Writes `<vault>/.dome/config.yaml` from a shipped default (extension
   activation + engine settings). First-write-only.
4. Writes `<vault>/.gitignore` (ignores `.dome/state/` per
   [[wiki/specs/vault-layout]] §"Git repository structure"). First-write-only.
5. Writes `<vault>/AGENTS.md` from the shipped orientation template
   (per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]]). The
   `CLAUDE.md` shim is a v1.1 follow-up — Claude Code is the v1.0
   harness and auto-loads `AGENTS.md` directly. First-write-only —
   re-runs preserve any user-prose section the vault owner added.
6. Creates an initial scaffold commit (`dome init: initial scaffold`)
   staging `.gitignore`, `AGENTS.md`, and `.dome/config.yaml`. Skipped
   if HEAD already resolves (re-init on a vault with commits is a
   no-op for this step).

Deferred to v1.1:
- `.dome/page-types.yaml` (page-type registry) — lands when the
  page-types substrate ships.
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

Each step prints a one-line outcome (`created` or `skipped (already
present)`); idempotent re-runs surface as all-skipped no-ops.

Exit codes: 0 on success (including idempotent re-runs); 1 on
unexpected I/O failure; 64 (EX_USAGE) on malformed path argument.

### `dome sync [--vault <path>] [--bundles-root <path>] [--json] [--force-advance]`

The one-shot catch-up: detect drift between the working-tree HEAD and `refs/dome/adopted/<branch>`, construct a `manual`-source Proposal, run it through the engine's adoption loop, print the result, exit. This is the manual trigger for users who don't want a `dome serve` daemon running continuously.

Composition (v1.0):

1. Resolve `vaultPath` (default cwd) and `bundlesRoot` (default SDK-shipped `assets/extensions/` via `resolveShippedBundlesRoot()`; optional override to `<vaultPath>/.dome/extensions` for vault-local bundles).
2. Inspect drift via the shared `detectDrift` helper (same code path `dome serve` polls in a loop).
3. Branch on drift outcome:
   - **detached HEAD** → exit 64 (EX_USAGE) with a clear stderr message.
   - **no commits** → exit 64 with a stderr message asking for an initial commit.
   - **in-sync** → open the runtime, run one operational-work pump against the adopted commit (due schedule triggers, durable jobs, and outbox rows already pending before the pump started), print `dome sync: already in sync (<head> on <branch>)`, exit 0.
   - **drift** → open the runtime, run `runOneAdoption`, then after a successful adoption run the same operational-work pump against the new adopted commit; print the result block (or `--json` payload), exit 0 (adopted) or 1 (blocked).
4. Close the runtime on the way out.

`--json` emits a single JSON object on stdout suitable for cross-tool consumption:

```json
{"status":"adopted","branch":"main","base":"abc...","head":"def...","adoptedRef":"def...","iterations":1,"closureCommit":null,"diagnostics":[]}
```

`status` is one of `"adopted" | "blocked" | "in-sync" | "error"`. The `error` field is only present on the usage-error variant.
For `"in-sync"`, `diagnostics` contains diagnostics produced by the operational-work pump, if any; no adoption diagnostics are synthesized because no adoption ran.

The `--force-advance` flag is **deferred** in v1.0. The adopted-ref substrate's fast-forward-only check is in place; the bypass surface lands when the adopted-ref-divergence recovery flow is wired end-to-end (a v1.1 polish). Until then, a divergent HEAD surfaces as a blocking diagnostic from `setAdoptedRef` and the operator resolves manually.

Exit codes: 0 on adopted / in-sync; 1 on blocked or runtime-open failure; 64 (EX_USAGE) on detached HEAD or no commits.

See [[wiki/specs/adoption]] §"`dome sync`" for the broader normative description.

### `dome status [--json]`

See [[wiki/specs/adoption]] §"`dome status`".

### `dome query <text> [--filter category=<c>] [--filter type=<t>] [--require-evidence] [--json]`

Runs `AbstractSurface.query` with the supplied text and filters. Output (text mode):

```text
dome query: 4 matches for "platform ownership"

1. wiki/syntheses/platform-team-ownership.md (high relevance)
   "Atlas owns runtime; platform owns infrastructure boundaries..."
   sourceRef: wiki/syntheses/platform-team-ownership.md:14-22 @ 41a98c2

2. wiki/dailies/2026-05-23.md
   "Discussed platform ownership with Danny..."
   sourceRef: wiki/dailies/2026-05-23.md:48-52 @ 41a98c2

(further matches truncated; --limit to show all)
```

`--json` emits structured `QueryResult`. `--require-evidence` filters to results carrying SourceRefs.

### `dome lint [--apply <id>] [--report-only]`

Runs the `dome.lint` view-phase processor against the adopted snapshot. The processor walks the wiki, emits DiagnosticEffect for each finding, writes a structured report to `inbox/review/lint-report-YYYY-MM-DD.md` with stable finding ids (H1, H2, M1, etc.).

`--apply <id>` invokes `dome.lint` in apply-mode for the named finding: re-resolve the finding's PatchEffect against current state, submit as a Proposal. The finding's annotation in the report flips to `Applied: <commit-oid>` or `Apply-failed: <reason>`.

`--report-only` skips finding application even if `--apply` is passed; useful for inspecting what would happen.

Exit codes: 0 on success (whether findings were found or not); 1 on apply failure; 2 on usage error.

### `dome rebuild`

Wipes `<vault>/.dome/state/projection.db` and rebuilds from the adopted commit per [[wiki/specs/projection-store]] §"Rebuild path". The run ledger (`runs.db`) and outbox (`outbox.db`) are preserved. Output:

```text
dome rebuild: rebuilding projection.db from adopted commit 41a98c2...
  walking wiki/... 234 pages
  walking raw/... 187 captures
  re-running adoption-phase processors... 9 processors
  re-running garden-phase fact-emitters... 4 processors
  done (8.3s; projection.db now 3.2 MB)
```

Exit codes: 0 on success; 1 on rebuild failure (engine error); 2 on usage error.

### `dome stats`

Renders summary statistics:

```text
vault: /Users/mark/vaults/work
  branch:   main
  adopted:  41a98c2 (current)
  pages:    1,247 wiki / 412 raw / 87 notes / 14 inbox-pending
  log:      8,143 entries
  ledger:   13,847 runs (last 30d: 412; last 7d: 89)
  outbox:   2 pending, 0 failed
  bundles:  3 (dome.markdown, dome.graph, dome.lint)
  invariants: <linked count from canonical INVARIANTS const>
```

The `<linked count>` is rendered from `src/types.ts` `INVARIANTS` at run time — not inlined as a literal.

### `dome inspect <subject> [--limit <n>] [--json]`

Read-only view over the operational substrate. The command opens the
runtime (so the three databases are initialized) but does not submit a
Proposal, does not invoke any processor, and does not mutate state.

Subjects (v1.0):

- `runs` — recent processor runs from `runs.db`.
- `diagnostics` — current unresolved diagnostics from `projection.db.diagnostics`.
- `questions` — open questions from `projection.db.questions`.
- `outbox` — pending / failed external actions from `outbox.db`.

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

### `dome doctor [--repair]` *(reserved for v1.x)*

Engine-substrate **health check** verb. v1.0 reserves the name and
ships no checks; v1.x implements the surface.

**Design (v1.x).** `dome doctor` (no flags) runs a closed set of
health-check probes against the engine substrate — orphan runs,
stuck-outbox rows, dirty git state, drift age, schema skew, AGENTS.md
template drift, bundle load failures. Each probe is a **garden-phase
scheduled processor** in the `dome.health` first-party bundle, fired
on a periodic cron or on engine signals (e.g.,
`engine.outbox.terminal-failure`). Probes emit DiagnosticEffects with
`source: engine.health` that persist to `projection.db.diagnostics`
and surface via `dome inspect diagnostics`.

`dome doctor` itself is a **view-phase command-triggered processor**
(`dome.health.render-report`) that reads the persisted probe findings
plus does on-demand ad-hoc readings, returning a ViewEffect with the
assembled report. The verb-form invocation is the user-facing "is my
vault healthy?" surface; the persisted findings are the durable
audit trail.

`--repair` applies the safe subset of mitigations — running answer-handler
processors for any pending `dome.health.*` questions and triggering
garden-phase repair processors (e.g., AGENTS.md template re-merge).

**v1.0 placeholder behavior.** `dome doctor` prints a one-line notice
("`dome doctor`: no health checks ship in v1.0; reserved for v1.x —
see `wiki/specs/cli.md` §`dome doctor`") and exits 0. `--repair` exits
64 with the same pointer.

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
- **Auto-mitigations** (AGENTS.md template drift, schema-mismatch
  rebuild, orphan-commit GC) → handled inline by garden-phase
  processors with no CLI surface; the engine just does them.
- **Synchronization** (`--drain-processors`) → `dome wait` or absorbed
  into `dome status --wait-quiet`. Doesn't fit the engine-asks model
  because there's no decision; it's a "block until quiet" verb.

This collapses the v0.5 / pre-recut "doctor as admin grab-bag" into
three named surfaces (`show`, `doctor`, `answer`) plus the existing
processor substrate.

### `dome answer <question-id> [<value>]` *(reserved for v1.x)*

The universal **user-decision channel** for QuestionEffects the engine
has raised but cannot resolve autonomously.

**Why a single answer surface (not per-substrate verbs).** The engine
already has a primitive for "I need a human decision" — `QuestionEffect`
in the closed taxonomy at [[wiki/specs/effects]] §"QuestionEffect".
When operational substrate gets stuck (outbox row terminally failed,
processor quarantined, force-advance needed across a divergent
adopted ref), the natural pattern is:

1. **Engine publishes a signal** (e.g., `engine.outbox.terminal-failure`).
2. **A garden-phase processor in `dome.health`** subscribes to the
   signal and emits a `QuestionEffect` with options (e.g., `["retry",
   "abandon", "wait"]`), `idempotencyKey` set to the underlying row id,
   and `sourceRefs` pointing at the substrate row.
3. **User runs `dome inspect questions`** to see pending questions.
4. **User runs `dome answer <question-id> retry`** to resolve.
5. **A second garden-phase processor in `dome.health`** subscribes to
   the `question.answered` signal, looks up the question's
   `idempotencyKey` → outbox-id, and emits the appropriate effect to
   mutate the outbox row.

The CLI surface is one verb (`dome answer`); the per-substrate logic
lives in the `dome.health` bundle's answer-handler processors. Adding
a new operational mutation type is one new question-emitter + one
new answer-handler in the bundle; no new CLI command.

**Design (v1.x).** `<question-id>` is the question row's id (from
`dome inspect questions`). `<value>` is one of the question's options
(when `options` is set) or free-form text (when `options` is null).
Without `<value>`, `dome answer <question-id>` prints the question
and its options.

Answering writes to `projection.db.questions` (sets `answered_at` +
`answer`) and emits an `engine.question.answered` signal. The
relevant garden-phase answer-handler processor catches the signal
and applies the mutation.

**v1.0 placeholder behavior.** `dome answer` exits 64 with a pointer
to this section. Since `dome.health` doesn't ship in v1.0, no
processor in the v1.0 substrate emits operational QuestionEffects;
the only Questions on the table today are content-questions written
back to the originating page via `dome.intake` per
[[wiki/specs/effects]] §"QuestionEffect" (also pending the `dome.intake`
shipping date).

### `dome serve [--vault <path>] [--bundles-root <path>] [--poll-interval-ms <n>]`

Runs the commit-watcher daemon — the canonical write path per [[v1]] §13.2 ("Claude Code edits project notes"). The user commits markdown via `git commit` (directly or via their harness's native write tool); the daemon catches up by adopting the new HEAD.

Composition (v1.0):

1. `openVaultRuntime({vaultPath, bundlesRoot})` opens the three operational databases (`projection.db`, `outbox.db`, `runs.db`) and loads extension bundles from the resolved bundles root (SDK-shipped `assets/extensions/` by default; vault-local `.dome/extensions/` only when explicitly selected).
2. Resolves the initial branch via `getCurrentBranch`. A detached HEAD is a startup error (the adopted-ref substrate requires a branch).
3. Polls `refs/heads/<branch>` every `--poll-interval-ms <n>` (default 500ms). On each tick, compares HEAD to `refs/dome/adopted/<branch>`:
   - If the adopted ref is uninitialized: runs an empty-diff `(HEAD, HEAD)` adoption to initialize it.
   - If HEAD equals the adopted ref: no adoption work; quiet in-sync ticks may still run due operational work on the daemon's internal cadence.
   - Otherwise: constructs a `manual`-source Proposal via `makeManualProposal({base: adopted, head: HEAD, branch})` and routes it through the engine's `adopt()`.
4. Adoption runs; effects route through `buildSqliteSinks` (projection + outbox writes) + the engine's candidate-tree `applyPatch` sink. View delivery remains a placeholder sink in v1.0.
5. The daemon also runs operational-work pumps while HEAD is already in sync, on a quiet internal cadence. This is how schedule triggers, durable jobs, and outbox retries that become due solely because time passed make progress in a quiet vault. Default output stays silent; `--verbose` may print counts.
6. Stays running until SIGINT / SIGTERM; on shutdown, closes the runtime (releases the three sqlite handles) and exits 0.

The watcher mechanism is **poll-based** (not filesystem-event-based). Poll is simpler than `fs.watch` on `.git/refs/heads/<branch>`, requires no extra dependencies, and 500ms latency is invisible to a user committing markdown. The v0.5 chokidar-over-`wiki/` watcher was retired with the v1.0 substrate migration — adoption is keyed off git commits, not raw file writes, so the watch target is a ref (one file) rather than the whole vault subtree.

The scheduled-trigger dispatcher for garden/view processors is wired through the same runtime grant resolver as adoption. The `--mcp` toggle remains deferred to v1.1.

Exit codes: 0 on graceful shutdown; 1 on startup error (detached HEAD, runtime open failure, malformed `--poll-interval-ms`).

### `dome export-context <topic>`

Renders a portable context packet (markdown) summarizing what the vault knows about `<topic>`. Used for cross-AI handoff (e.g., paste into ChatGPT to give it the relevant context from your Dome vault). Composes adopted-state reads + FTS query + Fact lookups; the output is a single markdown document.

### `dome migrate`

Upgrades a vault between SDK schema versions. The migration is idempotent — running it on an already-current vault is a no-op. Specific migrations are encoded as command-triggered processors in `dome.migrate`; the CLI command dispatches them in order.

### `dome run-processor <id> [--args <json>]`

Direct invocation of a processor by id. Used for testing and for processors that don't have a dedicated CLI command. The id is `<bundle>:<processor-id>`; the `--args` payload is the processor's `ProcessorContext.input`. The processor runs in its declared phase; only command-triggered processors are invokable this way (signal/path/schedule processors fire via the engine).

## Adding a new command

The "Adding a new command" recipe parallels [[wiki/specs/sdk-surface]] §"Adding a processor" — CLI commands are command-triggered view-phase processors. Four file edits:

1. **The processor file** at `assets/extensions/<bundle>/processors/<command-name>.ts` exporting a Processor with `phase: "view"` and `triggers: [{ kind: "command", name: "<command-name>" }]`.
2. **The manifest entry** in the bundle's `manifest.yaml` declaring the processor.
3. **A Commander binding** in `src/cli/cli.ts` (`program.command("<name>")...action(...)`) that routes to `AbstractSurface.commands[<name>].invoke(args)`.
4. **An end-to-end test** at `tests/integration/cli-<command>.test.ts` exercising the CLI invocation against a fixture vault.

The CLI Commander layer is the thin protocol adapter; the work happens in the processor. Adding a command that does *not* need a dedicated `dome <name>` Commander binding is three edits — register the processor; invoke via `dome run-processor <bundle>:<id>` or `dome run-command <name>` (MCP) or the AbstractSurface API directly.

The substrate scaffold catches missing pieces:
- `tests/integration/cli-shell-shape.test.ts` enumerates command-triggered processors in `assets/extensions/dome.*/processors/` and asserts each has either a Commander binding in `cli.ts` or a documented `dome run-processor` invocation in `cli.md`.

## Why the CLI surface is rich (not minimal)

The CLI is the primary v1 surface for agentic harnesses. Every operation the harness might want to invoke explicitly — `sync`, `query`, `lint`, `stats`, `doctor` — is a named CLI command, not a generic dispatch path. The structural payoff: a harness's AGENTS.md teaches "here are the named operations; invoke `dome <name>`"; the agent reaches for them like it reaches for `git status` or `npm test`. Rich, named, well-documented CLI commands match the agentic-harness mental model better than a single generic dispatcher.

The MCP server (per [[wiki/specs/mcp-surface]]) is the alternative for harnesses that prefer typed read/query routing; command-style views are reachable through `dome.run_command`. Adoption catch-up remains CLI/git-native in v1.0.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the AbstractSurface this adapter renders.
- [[wiki/specs/harnesses]] — when the CLI vs MCP earns its keep.
- [[wiki/specs/adoption]] — what `dome sync` / `dome status` consult.
- [[wiki/specs/processors]] — view-phase command processors.
- [[wiki/matrices/protocol-adapter]] — CLI as one row in the adapter map.
