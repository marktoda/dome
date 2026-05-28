---
type: spec
created: 2026-05-27
updated: 2026-05-27
sources: ["[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]", "[[v1]]"]
---

# CLI

This spec is normative for Dome's command-line interface. The CLI is **one protocol adapter** over [[wiki/specs/sdk-surface]] §"AbstractSurface" — argv routes to Submit, Recall, or a view-phase command processor.

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
dome doctor [--repair] [--show <subject>] [--<flag>]
                                Diagnostic and maintenance command.
dome serve [--vault <path>]     Run the compiler daemon (watcher + scheduled processors).
dome export-context <topic>     Render a portable context packet for cross-AI handoff.
dome migrate                    Upgrade vault for newer SDK schema.
dome run-processor <id> [--args ...]
                                Invoke a specific command-triggered processor by id.
```

The CLI is the user-facing primary surface in v1. Every command above maps to one of:

- **Submit:** `dome sync` — the catch-up write path that triggers an adoption run.
- **Recall:** `dome query`, `dome status` — read paths through `AbstractSurface.query` / `getAdoptionStatus`.
- **View-phase commands:** `dome lint`, `dome stats`, `dome export-context` — command-triggered view-phase processors invoked via `AbstractSurface.commands`.
- **Engine control:** `dome rebuild`, `dome doctor`, `dome serve` — engine + diagnostic operations exposed only on the CLI surface.
- **Lifecycle:** `dome init`, `dome migrate` — vault construction and schema upgrade, exposed only on the CLI.

The `dome submit` command is **retired in v1.0** (Phase 11a demolition). It was the wrong shape: the canonical client-to-engine write path is plain `git commit`, observed by the engine's watcher daemon (`dome serve`). For a one-shot catch-up (the daemon isn't running and the user wants the current working tree adopted), use `dome sync`. The `dome reconcile` deprecated alias from v0.5+phase1+phase3 is **also retired in v1.** Callers see "unknown command" and a pointer to `dome sync`.

## Per-command specs

### `dome init [path]`

Creates a new Dome vault at `<path>` (defaults to `.`):

1. Initializes a git repository if one doesn't exist.
2. Creates the directory scaffold: `wiki/`, `raw/`, `inbox/raw/`, `notes/`, `.dome/`.
3. Writes `AGENTS.md` and `CLAUDE.md` at vault root.
4. Writes `.dome/config.yaml` and `.dome/page-types.yaml` from shipped defaults.
5. Copies `assets/extensions/dome.*` bundles into `.dome/extensions/`.
6. Creates initial `log.md` and `index.md` (empty projections).
7. Runs an initial `dome sync` to adopt the initial commit and produce `refs/dome/adopted/main`.

Exit codes: 0 on success; 1 if directory exists with a vault (`config.yaml` present); 2 on usage error.

### `dome sync [--force-advance]`

See [[wiki/specs/adoption]] §"`dome sync`".

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
  bundles:  9 (dome.markdown, dome.index, dome.log, dome.links, dome.intake, dome.daily, dome.lint, dome.search, dome.migrate)
  invariants: <linked count from canonical INVARIANTS const>
```

The `<linked count>` is rendered from `src/types.ts` `INVARIANTS` at run time — not inlined as a literal.

### `dome doctor [--repair] [--show <subject>] [--flag ...]`

Diagnostic and maintenance command. Subjects under `--show`:

- `runs` — recent processor runs.
- `cost` — per-processor LLM spend.
- `outbox` — pending / failed external actions.
- `diagnostics` — current blocking and warning diagnostics.
- `questions` — open user questions.
- `orphan-runs` — runs stuck in "running" state.
- `recent-activity` — log.md tail.
- `recent-hook-cycles` (retired in v1; `recent-processor-divergence` replaces it).
- `recent-processor-divergence` — recent fixed-point cap-hits.

Flags:

- `--repair` — regenerate AGENTS.md templated sections; re-copy first-party bundles from SDK; rebuild log.md from ledger.
- `--rebuild-index` — equivalent to `dome rebuild` for index.md only.
- `--drain-processors` — wait for the garden-phase queue to settle.
- `--reset-quarantined-processors` — clear `.dome/state/quarantined.json` after debugging a quarantined processor.
- `--outbox-replay <key>` — re-attempt a failed outbox entry by idempotency key.
- `--outbox-abandon <key>` — mark a failed outbox entry as abandoned (won't retry).
- `--time-since-reconcile` — read `.dome/state/last-reconcile-mtime.txt`; report drift age.
- `--check-all` — run every validation check; aggregate violations.

### `dome serve [--vault <path>] [--port <n>] [--mcp]`

Runs the compiler daemon. Composition:

1. `openVault(path)` constructs the Vault.
2. Starts the working-tree watcher (chokidar over `<vault>/wiki/`, `raw/`, `notes/`, `inbox/`).
3. Starts the scheduled-trigger dispatcher (consults `projection_store.schedule_cursors`).
4. On each watcher event, constructs a `manual`-source Proposal via `makeManualProposal` and routes it through the engine's `adopt()`. Adoption runs; effects route per `apply-effect.ts`.
5. On each scheduled cron tick, fires the matching garden-phase processors.
6. If `--mcp` is passed, also starts the MCP server (per [[wiki/specs/mcp-surface]]).

Stays running until SIGINT / SIGTERM; on shutdown, `vault.close()` drains processors and releases handles.

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

The CLI is the primary v1 surface for agentic harnesses. Every operation the harness might want to invoke explicitly — `submit`, `query`, `lint`, `stats`, `doctor` — is a named CLI command, not a generic dispatch path. The structural payoff: a harness's AGENTS.md teaches "here are the named operations; invoke `dome <name>`"; the agent reaches for them like it reaches for `git status` or `npm test`. Rich, named, well-documented CLI commands match the agentic-harness mental model better than a single generic dispatcher.

The MCP server (per [[wiki/specs/mcp-surface]]) is the alternative for harnesses that prefer typed routing; the same operations are reachable through `dome.submit`, `dome.query`, `dome.run_command`. Either surface works; the CLI is the v1 default.

## Related

- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the AbstractSurface this adapter renders.
- [[wiki/specs/harnesses]] — when the CLI vs MCP earns its keep.
- [[wiki/specs/adoption]] — what `dome submit` / `dome sync` / `dome status` consult.
- [[wiki/specs/processors]] — view-phase command processors.
- [[wiki/matrices/protocol-adapter]] — CLI as one row in the adapter map.
