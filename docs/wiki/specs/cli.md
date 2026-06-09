---
type: spec
created: 2026-05-27
updated: 2026-06-09
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
---

# CLI

This spec is normative for Dome's command-line interface. The CLI is the
shipped v1 protocol adapter. It routes through the runtime directly today and
should converge with the planned [[wiki/specs/sdk-surface]] §"AbstractSurface"
for reads and view commands once that boundary lands, while keeping CLI-only
engine-control verbs such as `sync`, `serve`, and `rebuild`.

## The CLI surface

```text
dome init [path] [--with-model-provider anthropic]
                                Initialize a new vault.
dome capture [text] [--file <path>] [--title <t>] [--json]
                                Frictionless capture: write a timestamped raw
                                source into inbox/raw/ and commit it on the
                                current branch. Returns immediately.
dome sync [--json] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]
                                Catch-up: construct Proposal from working-tree HEAD; adopt.
dome status [--loops] [--json]  Vault health + content dashboard.
dome check [--engine] [--content] [--decisions] [--loops] [--attention] [--limit <n>] [--json]
                                Explain compiler attention across health,
                                diagnostics, and decisions.
dome resolve <question-id> [<value>]
                                Resolve a Dome-raised decision from `check`.
dome query <text> [--category <c>] [--type <t>] [--limit <n>] [--json]
                                FTS + structured query against adopted state.
dome export-context <topic> [--limit <n>] [--json]
                                Portable source-backed context packet.
dome serve [--vault <path>] [--daemon] [--poll-interval-ms <n>] [-v|--verbose]
           [--filter-processor <glob>] [-q|--quiet]
                                Run the local compiler host. Polls refs/heads/<branch>
                                every 500ms; constructs a manual Proposal and adopts on drift.
dome install [--vault <path>] [--status] [--env KEY=VALUE]... [--env-file <path>] [--json]
                                Install `dome serve` for this vault as a macOS launchd
                                LaunchAgent (ambient compiler host; survives reboots).
dome uninstall [--vault <path>] [--json]
                                Boot out and remove the vault's launchd LaunchAgent.
dome mcp [--vault <path>]       Run the stdio MCP server over this vault: typed
                                read/capture tools (capture, query, export_context,
                                status, check, resolve, tasks, brief) for MCP
                                harnesses. The daemon still owns compilation.
```

The CLI is the user-facing primary surface in v1. The implemented commands above map to one of:

- **Primary compiler loop:** `dome serve`, `dome sync`, `dome status`, `dome check`, and `dome resolve`. `serve` is the foreground compiler host; `sync` is the one-shot catch-up path; `status` is the cheap pulse and next-action router; `check` explains remaining attention across engine health, content diagnostics, and open decisions; `resolve` records an owner or agent answer to a Dome-raised decision and dispatches answer handlers.
- **Adopted-state recall surfaces:** `dome query` and `dome export-context` are the normal explicit read views when the user or a foreground agent asks for recall, planning, agenda context, or handoff material. They route through the shipped view-command boundary today and should map to `AbstractSurface.query` / command views once that planned boundary lands.
- **Advanced/debug and compatibility surfaces:** `dome inspect`, `dome doctor`, `dome lint`, `dome answer`, `dome run`, and `dome rebuild` remain available for detailed state inspection, extension development, and maintenance. They are hidden from top-level help and are not the normal Claude Code workflow.

`dome doctor` is read-only in V1. The `--repair` flag is a reserved surface for
future answer-mediated mitigations and exits with usage status instead of
mutating state. Operational recovery mutations ship through `dome.health`
questions and `dome resolve`, so recovery still goes through normal Effect
routing and capability checks.
- **View-phase commands:** `dome run <name>` plus dedicated wrappers such as `dome query`, `dome lint`, and `dome export-context` — command-triggered view-phase processors invoked through the shared view-command boundary. Daily planning processors remain available through `dome run` for tests/debugging, but they do not have dedicated top-level CLI verbs.
- **Capture ingress:** `dome capture` — the frictionless write-side entry point ([[wedge]] §"Phase 3 — Capture loop"). It writes a timestamped raw source into `inbox/raw/` and lands it as an ordinary human commit on the current branch; adoption and `dome.agent.ingest` handle everything after the commit boundary. See [[wiki/specs/capture]] for the capture-loop spec and the phone/voice ingress recipe.
- **Lifecycle:** `dome init` — vault construction; `dome install` / `dome uninstall` — ambient service lifecycle for the local compiler host on macOS (launchd LaunchAgent around `dome serve`, per [[wedge]] §"Phase 1 — Ambient daemon"). Schema migration is currently handled by storage open/rebuild paths; a dedicated `dome migrate` remains a v1.x roadmap item.
- **Protocol adapter:** `dome mcp` — the stdio MCP server ([[wedge]] §"Phase 5 — MCP server"). A read/capture protocol adapter over the same command handlers; see [[wiki/specs/mcp-surface]].

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
and `dome export-context`) also validate the returned `ViewEffect` boundary.
Each wrapper expects exactly one view with the canonical effect `name` and
structured `schema` for that command before rendering. `dome run` remains the
generic extension escape hatch and renders the processor's own view payloads
without imposing a first-party schema.

## Per-command specs

### `dome init [path] [--refresh-config] [--refresh-instructions] [--with-model-provider anthropic]`

Creates a new Dome vault at `<path>` (defaults to `.`). Phase 11f
hotfix: `dome init` no longer copies the shipped first-party bundles
into the vault. They live with the SDK at `<SDK>/assets/extensions/`
and are resolved at runtime via `resolveShippedBundlesRoot()`. Normal CLI
commands also compose an existing vault-local `.dome/extensions/` root after
the shipped root, so third-party bundles only need a local bundle directory
and an enabled `.dome/config.yaml` stanza. Per [[wiki/specs/vault-layout]]
§"`extensions/`" and docs/v1.md §10.1, the vault carries activations + grants
in `.dome/config.yaml`; shipped bundle code itself doesn't need to be copied
into every vault.

The shipped initialization steps:

1. Initializes a git repository if one doesn't exist (`git init` is
   idempotent — a no-op when `.git/` already exists).
2. Creates the directory scaffold: `wiki/`, `notes/`, `inbox/raw/`,
   `inbox/processed/`, and `.dome/state/`. `inbox/raw/` is the raw
   capture drop-zone once `dome.agent` is enabled and model-ready; generated
   AGENTS guidance tells Claude Code to verify the `dome.agent` row from
   `dome inspect bundles --json` reports `status: "enabled"` and
   `model: "ready"` before using raw captures. `inbox/processed/` is the
   archive target for processed captures. `.dome/extensions/` is not created —
   the shipped bundles live
   with the SDK; users wanting vault-local third-party bundles create the
   directory themselves.
3. Writes `<vault>/.dome/config.yaml` from a shipped default (extension
   activation + engine settings). First-write-only by default.
   `--refresh-config` is an explicit maintenance path for old or hand-edited
   first-party configs: it adds missing first-party default bundle stanzas and
   fills missing first-party default grant keys for already enabled first-party
   bundles while preserving existing grant values, explicitly disabled bundles,
   and third-party bundle config. When it changes the file, it rewrites the YAML
   into normalized form so stale comments from older generated configs do not
   contradict the active grants.
4. When `--with-model-provider anthropic` is supplied, copies the shipped
   first-party provider template from
   `<SDK>/assets/model-providers/anthropic.ts` to
   `<vault>/.dome/model-provider.ts` and adds a command-provider stanza to
   `.dome/config.yaml`:
   `model_provider: { kind: "command", command: ["bun", ".dome/model-provider.ts"] }`.
   The template is shipped data (resolved like the `assets/extensions/`
   bundles, never imported by any `src/` module — the
   [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] fence stays
   intact). It is a self-contained Bun script speaking the full
   JSON-over-stdio protocol — `dome.model-provider.request/v1` (one-shot
   text), `dome.model-provider.step/v1` (tool-use step), and
   `dome.model-provider.probe/v1` (cheap liveness probe, no API call) —
   against the Anthropic Messages API using plain `fetch` (no new
   dependency). It expects `ANTHROPIC_API_KEY` at runtime; the default
   model is `claude-sonnet-4-6`, overridable per-request via the envelope's
   `model` field or globally via `ANTHROPIC_MODEL`. `ANTHROPIC_BASE_URL`,
   `ANTHROPIC_MAX_TOKENS`, and `ANTHROPIC_INPUT_COST_PER_MTOK` /
   `ANTHROPIC_OUTPUT_COST_PER_MTOK` are further env overrides. The template
   reports `costUsd` from token usage for known model families (built-in
   price table, env-overridable), which is what makes the engine's
   `maxDailyCostUsd` caps effective by default. It does not enable
   `dome.agent` or any other model-capable bundle. Enabling model-backed
   loops remains an explicit config choice. Re-running
   `dome init --with-model-provider anthropic` on an existing vault is the
   supported wiring path for an already-initialized vault: the provider file
   and the `model_provider` stanza are each first-write-only, so the re-run
   adds whichever piece is missing and never overwrites a hand-edited
   provider or stanza.
5. Writes `<vault>/.gitignore` (ignores `.dome/state/` per
   [[wiki/specs/vault-layout]] §"Git repository structure"). First-write-only.
6. Writes `<vault>/AGENTS.md` from the shipped orientation template
   (per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]]) and
   `<vault>/CLAUDE.md` as a small Claude Code shim importing `AGENTS.md`.
   Claude Code reads `CLAUDE.md`, so the shim is part of the v1 boot
   path rather than polish. The generated instructions tell agents to inspect
   `serve_status` from `dome status --json` at session start, using
   `dome sync --json` after commits when no foreground `dome serve` host is
   running and to use `query` / `export-context` as read-first context surfaces
   for nontrivial vault work. First-write-only by default — re-runs preserve
   any local edits. `--refresh-instructions` is an explicit maintenance path
   for old orientation files: it replaces the managed AGENTS scaffold with the
   current shipped template while preserving the delimited user-prose block. If
   an older AGENTS file has no delimiters, its previous content is moved into
   the new user-prose block. The same flag prepends the `@AGENTS.md` shim to
   CLAUDE.md when missing, preserving existing file content below it.
7. Creates an initial scaffold commit (`dome init: initial scaffold`)
   staging `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and
   `.dome/config.yaml`, plus `.dome/model-provider.ts` when the provider
   scaffold was requested. Skipped if HEAD already resolves (re-init on a vault
   with commits is a no-op for this step).

Deferred to v1.1:
- `.dome/page-types.yaml` is not scaffolded by default. The page-type
  substrate ships today through built-in and bundle-contributed page types;
  this vault-local file remains an optional extension point for custom
  frontmatter schemas.
- The initial `dome sync` to produce `refs/dome/adopted/main` — the
  user runs `dome sync` (or `dome serve`) manually as their next step;
  the adopted-ref substrate initializes on first sync.

Installing a third-party bundle: create
`<vault>/.dome/extensions/<bundle-id>/` and enable the bundle in
`.dome/config.yaml`. `--bundles-root <path>` is an exact root override for
tests and ad-hoc development; it is not needed for normal vault-local
installation.

Each step prints a one-line outcome (`created`, `updated`, or `skipped
(already present)`); idempotent re-runs surface as all-skipped no-ops.

Exit codes: 0 on success (including idempotent re-runs); 1 on
unexpected I/O failure; 64 (EX_USAGE) on malformed path argument.

### `dome capture [text] [--file <path>] [--title <t>] [--vault <path>] [--json]`

Frictionless capture into the inbox — the Phase 3 wedge command ([[wedge]]
§"Phase 3 — Capture loop"). It takes a thought from anywhere (argument, file,
or stdin), writes it as a timestamped raw source under `inbox/raw/`, commits
that one file on the current branch, and returns immediately. Everything after
the commit boundary is the existing capture loop: the compiler host adopts the
commit, `dome.agent.ingest` integrates it (when `dome.agent` is enabled and
model-ready), and `dome.agent.inbox-stale-check` warns when raw captures sit
unprocessed. The broader loop and the phone/voice ingress recipe live in
[[wiki/specs/capture]].

Input resolution, in precedence order:

1. The positional `[text]` argument.
2. `--file <path>` — the capture body is read from that file (any text file;
   the path may live outside the vault). Combining positional text with
   `--file` is a usage error (exit 64).
3. Otherwise stdin is read to EOF (`echo idea | dome capture`). An interactive
   TTY with no piped input is a usage error rather than a hang.

Input that is empty after trimming is a usage error (exit 64); no file is
written and no commit is made.

The target path is `inbox/raw/<YYYY-MM-DD-HHmm>-<slug>.md`:

- The timestamp is the capture moment in **local time** (captures are human
  moments; an 11pm thought files under that evening's date).
- `<slug>` is derived from `--title` when given, else from the capture's first
  line (skipping any leading frontmatter block and `#` heading markers): up to
  six words, lowercased, non-`[a-z0-9]` runs collapsed to `-`, capped at 48
  chars, falling back to `capture` when nothing survives sanitization. An
  explicit `--title` gets the same single-line normalization as a derived
  title before any use: whitespace runs (including newlines) collapse to
  single spaces and the result is capped at 80 chars, so a title cannot
  inject extra lines — including `Dome-*` trailer-shaped ones — into the
  commit message.
- Collisions disambiguate deterministically: if the target path already exists
  in the working tree, `-2` is appended, then `-3`, and so on.

The written file is the documented raw-capture shape (normative in
[[wiki/specs/capture]] §"Raw capture file shape"): a frontmatter block with
`captured:` (ISO-8601 UTC instant) and `source: cli` (plus `title:` when
`--title` was given), then the capture body trimmed of surrounding
whitespace. No `type:` field —
`inbox/` roots may omit frontmatter typing per [[wiki/specs/page-schema]], and
the file is ephemeral (ingest archives it to `inbox/processed/`).

The commit is a **human write**, not an engine write: an ordinary commit with
message `capture: <title>` and **no `Dome-*` trailers** (per
[[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]], the daemon constructs
the Proposal from branch drift — capture never talks to the engine). The
commit author is `dome capture <dome-capture@local>`. Exactly
one path changes in the commit: a dirty working tree, including
already-staged-but-uncommitted changes, is **not** swept into the capture
commit. The commit is built against the HEAD tree plus the single capture
blob through the `src/git.ts` isomorphic-git boundary, so other staged work
stays staged and other dirty files stay dirty. The branch ref advance is
compare-and-swap: when a running serve host adopts (and moves the branch)
between capture's HEAD read and its ref write, the capture commit is rebuilt
on the new head and retried (bounded), instead of force-moving the branch
backwards past the engine's closure commit.

`dome capture` returns as soon as the commit lands — it does not wait for
adoption. Text output prints the vault-relative path, the commit, and a hint
about what happens next. The hint is status-aware using only cheap reads (the
serve heartbeat file and `refs/dome/adopted/<branch>`): when a running serve
host is visible and the adopted ref exists, it says the host will ingest the
capture on its next tick; otherwise it says compilation is pending and points
at `dome sync` / `dome serve`.

`--json` emits `dome.capture/v1`:

```json
{
  "schema": "dome.capture/v1",
  "status": "captured",
  "vault": "/Users/mark/vaults/work",
  "path": "inbox/raw/2026-06-09-2311-call-the-landlord.md",
  "title": "call the landlord",
  "captured_at": "2026-06-10T06:11:00.000Z",
  "source": "cli",
  "branch": "main",
  "commit": "41a98c2...",
  "serve_status": "running",
  "adopted_initialized": true,
  "compile_pending": false
}
```

`serve_status` mirrors the heartbeat read `dome status` uses (`running` /
`stale` / `off`); `compile_pending` is true when no running host is visible or
the adopted ref for the branch is uninitialized. Error cases emit
`{ schema, status: "error", vault, error }`.

Preconditions: the vault must be an initialized Dome vault — a git repository
with `.dome/config.yaml` present — with at least one commit and a non-detached
HEAD (the adopted-ref substrate needs a branch). Each violation is a usage
error (exit 64) with a pointer at `dome init` or `dome sync`.

`--bundles-root <path>` is accepted for harness compatibility (test harnesses
and agent wrappers append it to every CLI invocation, like the runtime-opening
commands' shared flag) and ignored: capture never loads bundles or opens the
runtime.

Exit codes: 0 on success; 64 (EX_USAGE) on empty input, text+`--file`
conflict, TTY-with-no-input, uninitialized vault, no commits, or detached
HEAD; 1 on an unreadable `--file` path or unexpected I/O failure.

### `dome sync [--vault <path>] [--bundles-root <path>] [--json] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]`

The one-shot catch-up: detect drift between the working-tree HEAD and `refs/dome/adopted/<branch>`, construct a `manual`-source Proposal, run it through the engine's adoption loop, print the result, exit. This is the manual trigger for users who don't want a `dome serve` compiler host running continuously.

Composition (v1.0):

1. Resolve `vaultPath` (default cwd) and bundle roots (default SDK-shipped `assets/extensions/` via `resolveShippedBundlesRoot()`, plus `<vaultPath>/.dome/extensions` when it exists; optional `--bundles-root` exact override).
2. Inspect drift via the shared `detectDrift` helper (same code path `dome serve` polls in a loop).
3. Branch on drift outcome:
   - **detached HEAD** → exit 64 (EX_USAGE) with a clear stderr message.
   - **no commits** → exit 64 with a stderr message asking for an initial commit.
   - **diverged** → refuse before opening the adoption loop because the adopted ref is not an ancestor of HEAD; print recovery guidance and exit 1.
   - **in-sync** → open the runtime, acquire the branch-level compiler-host lock, run one operational-work pump against the adopted commit (due schedule triggers, durable jobs, low-risk question auto-resolution when enabled, and outbox rows already pending before the pump started), print `dome sync: already in sync (<head> on <branch>)`, print durable attention / next-action lines when attention remains, exit 0.
   - **drift** → open the runtime, acquire the branch-level compiler-host lock, run `runOneAdoption`, then after a successful adoption run the same operational-work pump against the new adopted commit; print the result block plus durable attention / next-action lines when attention remains (or the `--json` payload), exit 0 (adopted) or 1 (blocked).
   - **busy** → another Dome host already holds the branch-level compiler-host lock; print a retryable busy message, exit 75.
4. Close the runtime on the way out.

`--json` emits a single JSON object on stdout suitable for cross-tool consumption:

```json
{"status":"adopted","branch":"main","base":"abc...","head":"def...","adoptedRef":"def...","iterations":1,"closureCommit":null,"garden":{"subProposalCount":1,"rejectedPatchCount":0,"diagnosticCount":0},"operational":{"scheduledCount":0,"jobCount":0,"outboxCount":0,"autoResolvedQuestions":0,"diagnosticCount":0},"health":{"pendingRuns":0,"orphanRuns":0,"failedRuns":0,"diagnostics":0,"contentDiagnostics":0,"unlocatedDiagnostics":0,"attentionDiagnostics":0,"questions":0,"outboxPending":0,"outboxFailed":0,"quarantined":0},"attention_required":false,"attention":[],"next_actions":[],"diagnostics":[]}
```

`status` is one of `"adopted" | "blocked" | "in-sync" | "busy" | "error"`. The `error` field is present on `"busy"` and error variants such as detached HEAD, no commits, runtime-open failure, or adopted-ref divergence.
`garden` summarizes post-adoption garden PatchEffects that spawned
sub-Proposals plus any garden-routing diagnostics. `operational` summarizes
the scheduled/job/outbox/auto-resolution pump. `autoResolvedQuestions` counts
low-risk `QuestionEffect` rows answered through the durable `dome resolve`
machinery by opt-in runtime policy; their answer handlers still route patches
through garden and adoption. `health` summarizes durable post-tick attention
state, including pending/failed runs, unresolved projection diagnostics,
source-backed content diagnostics, source-less unlocated diagnostics, open
questions, failed/pending outbox rows, and quarantines. `diagnostics`
contains adoption diagnostics plus garden and operational diagnostics; for
`"in-sync"`, it can contain only operational diagnostics because no adoption
ran.
`attention_required` is the agent-facing branch point. It is true for blocked
or errored adoption, compiler-host busy responses, garden rejected patches,
garden diagnostics, operational diagnostics, or durable health attention such
as unresolved warning/error/block content diagnostics and open questions.
`attention` contains stable
reason codes such as `adoption_blocked`, `compiler_host_busy`,
`garden_rejected_patches`, `garden_diagnostics`, and
`operational_diagnostics` so Claude Code can choose a recovery path without
deriving one from counters. `next_actions` maps those reasons to the next
command, using `dome check --json` for attention that needs explanation and
`dome sync --json` for retry/drain cases. If durable content diagnostics are
the only check-oriented sync attention reason, the next action routes directly
to `dome check --content --attention --limit 50 --json`.

`--quiet` suppresses non-error human-readable text for adopted / in-sync
outcomes. It does not suppress `--json`, usage errors, blocked-adoption
diagnostics, or compiler-host busy messages. `--quiet` and `--verbose` are
mutually exclusive.

In text mode, successful adopted / in-sync outcomes still print durable
attention lines after the normal result line when post-tick health needs user
action, for example:

```text
dome sync: already in sync (abc1234 on main)
dome sync: attention diagnostics, questions
  next: dome check --json - Explain remaining compiler attention across engine health, content diagnostics, and open decisions.
```

`--verbose` prints typed adoption-loop progress events. When
`--filter-processor <glob>` is present, verbose output includes only matching
per-processor result lines such as `dome.markdown.*`; iteration scaffolding is
suppressed so filtered logs stay focused.

The `--force-advance` flag is **deferred** in v1.0. The adopted-ref substrate's fast-forward-only check is in place; the bypass surface lands when the adopted-ref-divergence recovery flow is wired end-to-end (a v1.1 polish). Until then, a divergent HEAD is detected by the shared compiler-host drift boundary before any Proposal is constructed, and the operator resolves manually.

Exit codes: 0 on adopted / in-sync; 1 on blocked, adopted-ref divergence, or runtime-open failure; 64 (EX_USAGE) on detached HEAD or no commits; 75 (EX_TEMPFAIL) when another compiler host holds the branch lock.

See [[wiki/specs/adoption]] §"`dome sync`" for the broader normative description.

### `dome status [--loops] [--json]`

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
content   1,247 pages | wiki 1,247 | notes 87 | inbox 14 (2 raw) | links 8,143 | raw 412 files (2.4 MB)
engine    last sync 2026-05-28T12:34:56.000Z | pending 0 | failed 0 | serve running
health    projection fresh | diagnostics 0 | questions 0 | outbox 2 pending / 0 failed | quarantine 0
loops     5 known | 2 quiet | 0 attention | 1 drift | 1 partial | 1 inactive
```

`--loops` expands text mode with one row per maintenance loop: state, goal,
active/missing processors, diagnostic/question/problem-run counts, surfaces,
settlement no-op rule, latest run time, last successful run time, and the
latest active problem-run time when present. JSON output always includes the
same detail under `maintenance_loops`, so `--loops` is only a transcript-facing
readability option.

`--json` emits stable keys for agent consumption. Abbreviated shape:

```json
{
  "vault": "/Users/mark/vaults/work",
  "branch": "main",
  "head": "41a98c2...",
  "adopted": "41a98c2...",
  "sync_needed": false,
  "attention_required": true,
  "attention": ["diagnostics"],
  "inbox_pages": 14,
  "inbox_raw_pages": 2,
  "next_actions": [
    {
      "reasons": ["diagnostics"],
      "command": "dome check --content --attention --limit 50 --json",
      "description": "Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json."
    }
  ],
  "recent_processor_runs": [
    {
      "processor_id": "dome.daily.task-index",
      "processor_version": "1.0.0",
      "phase": "garden",
      "latest_run_id": "run_...",
      "latest_status": "succeeded",
      "latest_started_at": "2026-05-28T12:34:56.000Z",
      "latest_finished_at": "2026-05-28T12:34:56.140Z",
      "latest_duration_ms": 140,
      "recent_runs": 3,
      "recent_problem_runs": 0
    }
  ],
  "maintenance_loops": [
    {
      "id": "dome.context.packet",
      "goal": "Active work has concise source-backed context packets for foreground agents.",
      "state": "quiet",
      "processor_ids": ["dome.search.index-text", "dome.search.query", "dome.search.export-context"],
      "required_processor_ids": ["dome.search.index-text", "dome.search.query", "dome.search.export-context"],
      "optional_processor_ids": [],
      "active_processors": ["dome.search.index-text", "dome.search.query", "dome.search.export-context"],
      "missing_processors": [],
      "inactive_optional_processors": [],
      "surfaces": ["command:query", "command:export-context"],
      "settlement": {
        "key": "packet target + adopted source set + processor version",
        "no_op_when": "the packet or query result was produced from the same relevant source set"
      },
      "diagnostics": 0,
      "attention_diagnostics": 0,
      "drift_diagnostics": 0,
      "noise_diagnostics": 0,
      "questions": 0,
      "agent_safe_questions": 0,
      "model_safe_questions": 0,
      "owner_needed_questions": 0,
      "recent_runs": 3,
      "recent_problem_runs": 0,
      "latest_run_at": "2026-05-28T12:34:56.000Z"
    }
  ],
  "diagnostics": 12,
  "attention_diagnostics": 12,
  "diagnostic_summary": {
    "total": 12,
    "group_count": 1,
    "shown_groups": 1,
    "omitted_groups": 0,
    "groups": [
      {
        "severity": "warning",
        "code": "dome.markdown.broken-wikilink",
        "count": 12,
        "first_message": "...",
        "first_source_refs": "wiki/page.md:7",
        "firstSourceRefs": [{"commit": "41a98c2...", "path": "wiki/page.md"}]
      }
    ]
  },
  "attention_diagnostic_summary": {
    "total": 12,
    "group_count": 1,
    "shown_groups": 1,
    "omitted_groups": 0,
    "groups": [
      {
        "severity": "warning",
        "code": "dome.markdown.broken-wikilink",
        "count": 12,
        "first_message": "...",
        "first_source_refs": "wiki/page.md:7",
        "firstSourceRefs": [{"commit": "41a98c2...", "path": "wiki/page.md"}]
      }
    ]
  },
  "diagnostic_message_summary": {
    "total": 12,
    "group_count": 5,
    "shown_groups": 5,
    "omitted_groups": 0,
    "groups": [
      {
        "severity": "warning",
        "code": "dome.markdown.broken-wikilink",
        "message": "Wikilink [[wiki/sources/example]] does not resolve to any markdown file in the vault.",
        "count": 4,
        "first_source_refs": "wiki/page.md:7",
        "firstSourceRefs": [{"commit": "41a98c2...", "path": "wiki/page.md"}]
      }
    ]
  },
  "attention_diagnostic_message_summary": {
    "total": 12,
    "group_count": 5,
    "shown_groups": 5,
    "omitted_groups": 0,
    "groups": [
      {
        "severity": "warning",
        "code": "dome.markdown.broken-wikilink",
        "message": "Wikilink [[wiki/sources/example]] does not resolve to any markdown file in the vault.",
        "count": 4,
        "first_source_refs": "wiki/page.md:7",
        "firstSourceRefs": [{"commit": "41a98c2...", "path": "wiki/page.md"}]
      }
    ]
  },
  "diagnostic_disposition_summary": {
    "total": 12,
    "group_count": 2,
    "shown_groups": 2,
    "omitted_groups": 0,
    "groups": [
      {
        "disposition": "agent-fixable",
        "disposition_hint": "A vault-aware foreground agent can usually rename the link, create a source-backed stub, or leave the uncertainty intentional.",
        "count": 9,
        "attention_count": 9,
        "first_source_refs": "wiki/page.md:7",
        "firstSourceRefs": [{"commit": "41a98c2...", "path": "wiki/page.md"}]
      }
    ]
  },
  "attention_diagnostic_disposition_summary": {
    "total": 12,
    "group_count": 2,
    "shown_groups": 2,
    "omitted_groups": 0,
    "groups": [
      {
        "disposition": "agent-fixable",
        "disposition_hint": "A vault-aware foreground agent can usually rename the link, create a source-backed stub, or leave the uncertainty intentional.",
        "count": 9,
        "attention_count": 9,
        "first_source_refs": "wiki/page.md:7",
        "firstSourceRefs": [{"commit": "41a98c2...", "path": "wiki/page.md"}]
      }
    ]
  },
  "questions": 0,
  "outbox_pending": 0,
  "outbox_failed": 0,
  "quarantined": 0
}
```

`recent_processor_runs` is a bounded summary over the newest 100 run-ledger
rows, grouped by processor id. It is for status dashboards and agents that
need to spot the processor currently causing churn; `dome inspect runs`
remains the full audit surface.
`maintenance_loops` is a first-party V1 automation summary over the same
processor substrate. Loops are metadata, not runtime dispatch units: each row
names the desired-state objective, its implementing processor ids, command/path
surfaces, settlement rule, current state, and the unresolved
diagnostics/questions/recent problem runs attributable to those processors.
Loop diagnostic counts are disposition-aware: `diagnostics` remains the total
unresolved attributed diagnostics, `attention_diagnostics` counts
warning/error/block source-backed findings, `noise_diagnostics` counts
source-backed findings classified as `noise`, and `drift_diagnostics` counts
the remaining non-attention, non-noise findings that keep a loop unsettled.
`processor_ids` is the complete attribution set for processor runs and
diagnostics. `required_processor_ids` control whether a loop is inactive or
partial. `optional_processor_ids` name opt-in contributors; inactive optional
processors remain visible under `inactive_optional_processors` but do not make
the loop partial. `question_scope` is usually `processors`, meaning unresolved
questions are attributed from the loop's processor set. The cross-cutting
`dome.question.continuity` loop uses `all` so it reflects every open question,
including questions emitted by processors that primarily belong to another
maintenance loop.
Question counts are split into `agent_safe_questions`,
`model_safe_questions`, and `owner_needed_questions` using the same policy
classification as `dome check`; missing question metadata is owner-needed.
Because loops can intentionally overlap, those per-loop question counts are
attribution counts rather than a globally deduplicated question total; use the
top-level `questions` field for the unique open-question count.
For loop settlement, `recent_problem_runs` counts processors whose latest row
inside the bounded recent-run window is still an active problem state
(`failed`, `timed_out`, or `cancelled`, excluding health-recovered orphan
runs). Older failed rows remain visible in `recent_processor_runs` and
`inspect runs`, but a later successful run clears loop attention.
`latest_run_at`, `last_successful_run_at`, and `latest_problem_run_at` expose
the same bounded recent-run evidence per loop so dogfood snapshots can show
freshness, recovery, and the latest unresolved processor failure without
opening the full run ledger.
`state: "quiet"` means the loop is active and has no visible drift or attention;
`"attention"` means attention diagnostics, questions, or latest active problem runs are present;
`"drift"` means non-attention, non-noise diagnostics are visible but do not
route immediate attention;
`"partial"` means at least one required processor is not active while another
required processor is active; and `"inactive"` means none of the loop's
required processors are active.
`last_sync` is the started-at timestamp of the newest successful adoption- or
garden-phase run. Read-only view commands such as `dome query`,
`dome export-context`, `dome lint`, and hidden compatibility daily views remain
visible in `recent_processor_runs`, but they do not move `last_sync` because
they do not adopt or drain compiler work.
`attention_required` and `attention` summarize the status counters into stable
reason codes; `next_actions` maps those reasons to a small set of commands an
agent can safely follow. Current reasons include `adopted_ref_diverged`,
`sync_needed`, `projection_stale`, `dirty_modified`, `dirty_untracked`,
`pending_runs`, `failed_runs`, `serve_stale`, `diagnostics`, `questions`,
`outbox_pending`, `outbox_failed`, `quarantined`, and
`capture_loop_inactive`. Dirty reasons include bounded path samples in
`dirty_modified_paths` and `dirty_untracked_paths`, and the dirty-state
next-action description names those paths so a foreground agent can see the
immediate draft files without issuing another status command. The counts remain
authoritative; the path arrays are samples and may omit additional dirty paths
when a vault has a large draft set. `capture_loop_inactive` fires only when top-level
`inbox/raw/*.md` captures are present and the `dome.capture.digest` loop is
inactive, partial, or enabled without a configured model provider; its next
action routes through `dome inspect bundles --json` so a vault-aware agent can
inspect `dome.agent`, enable it in `.dome/config.yaml` when appropriate,
commit the config, and run `dome sync --json`. The `pending_runs` count
is the live queued/running ledger count, while `orphan_runs` is the subset of
running rows old enough for recovery; transient in-flight view or compiler
runs remain visible but only `orphan_runs > 0` contributes the `pending_runs`
attention reason. Text status output renders non-stale rows as `pending N live`
and stale rows as `pending N stale` or `pending N total (M stale)` so a
concurrent view command does not look like a stuck recovery state. `diagnostics`
and `content_diagnostics` count the unresolved source-backed rows that can be
repaired from markdown and summarized by `dome check --content`.
`unlocated_diagnostics` separately counts source-less rows such as
runtime/compiler diagnostics that remain available through
`dome inspect diagnostics`. `attention_diagnostics` is the warning/error/block
subset of source-backed content diagnostics. Informational diagnostics and
unlocated runtime diagnostics remain visible, but only source-backed
warning/error/block diagnostics contribute the `diagnostics` attention reason.
`failed_runs` counts processors whose latest run is an active terminal
problem (`failed`, `timed_out`, or `cancelled`). Rows failed by explicit
orphan-run recovery remain in `dome inspect runs` for forensics but do not keep
status in attention after the recovery path has completed.
`diagnostic_summary` groups all unresolved diagnostics;
`attention_diagnostic_summary` uses the same schema but includes only
source-backed warning/error/block rows. Text mode uses the attention summary
for `diag top` when actionable diagnostics exist, so informational and
unlocated runtime rows do not compete with the immediate markdown repair
target. `diagnostic_message_summary` and
`attention_diagnostic_message_summary` additionally group by
severity/code/message, so a status pulse can show distinct repair targets when
many findings share the same diagnostic code, such as several missing
wikilink targets. Text mode renders this message-level grouping as `diag fix`.
`diagnostic_disposition_summary` and
`attention_diagnostic_disposition_summary` classify source-backed content
diagnostics by who/what should handle them: `auto-fixable`, `agent-fixable`,
`owner-needed`, or `noise`. Disposition groups carry a short
`disposition_hint`, counts, attention counts, and first source refs. JSON keeps
separate groups when the same disposition has different hints; text mode
aggregates those groups by disposition as `diag plan`.
Diagnostic summary payloads include `group_count`, `shown_groups`, and
`omitted_groups` so bounded JSON consumers do not need to infer truncation from
array lengths. Diagnostic summary groups include both
`first_source_refs` (compact file/line display text for the repair loop) and
`firstSourceRefs` (structured SourceRef objects, including commit provenance).
If diagnostics are the only check-oriented attention
reason, status routes directly to
`dome check --content --attention --limit 50 --json`; otherwise it routes to
the broader `dome check --json` report. When `projection_stale` is the only
sync-oriented reason, the `dome sync --json` next-action description names the
projection rebuild explicitly instead of implying pending commits.

The analytics are cheap first-glance counts, not a graph report:
markdown pages under `wiki/`, `notes/`, and `inbox/`; wikilink
occurrences in those markdown files; raw file count and bytes under
`raw/`; sync drift, adopted-ref divergence, and pending commit count for
adopted..HEAD when the adopted ref is initialized and ancestral to HEAD; and
dirty working-tree counts and path samples excluding rebuildable
`.dome/state/` files. The operational counts are pointers, not full
reports. `serve_status` is read from the foreground host heartbeat file and is
`running`, `stale`, or `off`; stale means the host did not exit cleanly or has
not refreshed its heartbeat within the host's configured cadence. Text mode
annotates `serve off` as `serve off (run dome serve)` to nudge the normal
foreground-host workflow, but `off` is not itself an attention reason because
one-shot `dome sync` is a valid catch-up mode. Generated AGENTS guidance tells
Claude Code to read `serve_status` separately from `next_actions`, because
`next_actions` is scoped to compiler attention rather than host preference. Use
`dome check --json` for the normal explanation path and `dome inspect
diagnostics/questions/outbox/runs` only for row-level debugging. See
[[wiki/specs/adoption]] §"`dome status`" for the adopted-ref framing and
[[wiki/specs/foreground-compiler-workflow]] for the normal session pulse.

### `dome check [--engine] [--content] [--decisions] [--loops] [--attention] [--limit <n>] [--json]`

The unified read-only attention report. It exists so Claude Code and a human
operator have one "see what remains" command instead of choosing among
`doctor`, `lint`, `inspect diagnostics`, and `inspect questions`.

Default scope includes:

- **engine:** health findings from the operational substrate: adopted-ref
  divergence, projection cache drift, instruction drift, schema mismatches,
  failed or stuck outbox rows, orphan runs, latest active processor failures,
  quarantines, and model-provider configuration gaps;
- **content:** unresolved source-backed DiagnosticEffect rows with bounded
  grouping, SourceRefs, total/unlocated diagnostic counters, and
  warning/error/block content diagnostics that require attention;
- **decisions:** unresolved QuestionEffect rows with row ids, options,
  per-row `dome resolve` commands, SourceRefs, and optional automation
  metadata that separates agent/model-safe work from owner-needed decisions.

The `--engine`, `--content`, and `--decisions` flags narrow the report to one
or more scopes. Plain text mode is attention-focused by default: it preserves
content diagnostic totals but expands only warning/error/block content details
unless `--content` is explicitly requested. `--content` is the full text
content-audit surface. `--loops` expands text mode with the same maintenance-loop
detail rows as `dome status --loops`; JSON output always includes
`maintenance_loops` when the runtime opens and preserves the complete content
diagnostic payload unless `--attention` is requested. `--attention` narrows
content diagnostic rows and grouping to source-backed warning/error/block
diagnostics while preserving total, source-backed, unlocated, and
attention-diagnostic counters. `--limit` bounds
rows per section; when attention
rows are bounded, text mode renders `showing <n> of <total> attention` in the
content summary and prints an omitted-row hint such as
`... 22 more diagnostics (use --limit 34 to show all)` whenever a bounded
section is truncated. `--json` emits the
structured `dome.check/v1` payload. Diagnostic and decision items include
both `source_refs` (a compact file/line display string for the repair loop) and
`sourceRefs` (structured SourceRef objects for agents and other callers,
including commit provenance); diagnostic summary groups use the matching
`first_source_refs` / `firstSourceRefs` pair. Content reports also
include `message_summary`, which groups diagnostics by severity/code/message so
repeated findings such as one missing wikilink target can be handled as one
repair task before drilling into individual source rows. Content reports also
include `repair_summary`, which groups diagnostics by stable repair path such
as `link.resolve-or-create`, `asset.restore-or-relink`, or
`frontmatter.repair`; each diagnostic item carries the same `repair_path` plus
a short `repair_hint` so foreground agents can batch source edits without
guessing the intended repair route. The content `items` list follows the same
severity/count/message priority as `message_summary`, so bounded repair rows
start with the highest-volume grouped findings instead of newest-row insertion
order. Content reports also include `disposition_summary`, which classifies
each source-backed diagnostic as `auto-fixable`, `agent-fixable`,
`owner-needed`, or `noise`. Each diagnostic item carries the same
`disposition` and `disposition_hint`, making the remaining backlog explicit for
foreground agents and M10 dogfood evidence. Decision reports include
`agent_safe_questions`,
`model_safe_questions`, and `owner_needed_questions`; missing question metadata
is counted as `owner-needed`. Decision items include the raw `metadata` object
plus flattened `automation_policy`, `risk`, `confidence`,
`recommended_answer`, and `owner_needed_reason` fields for agents that want to
route work without understanding the full effect shape. Content and decision
reports expose
`shownItems` / `omittedItems` beside their bounded `items` arrays so agents can
record truncation evidence without inferring it from array lengths. The report
also includes `maintenance_loops`, the same first-party V1 loop summary exposed
by `dome status --json`, so the normal explanation surface can attribute
remaining work to the desired-state loop it belongs to. If the operational
runtime cannot be opened and `check` is reporting only a schema/storage problem,
`maintenance_loops` is `null`.
Abbreviated example:

```json
{
  "schema": "dome.check/v1",
  "status": "attention",
  "generatedAt": "2026-05-29T12:00:00.000Z",
  "scopes": {"engine": true, "content": true, "decisions": true},
  "engine": {"status": "unhealthy", "summary": {"findingCount": 1}},
  "content": {
    "diagnostics": 2,
    "content_diagnostics": 2,
    "unlocated_diagnostics": 0,
    "attention_diagnostics": 1,
    "summary": {"total": 2, "groups": [{"severity": "warning", "code": "dome.markdown.broken-wikilink", "count": 1}]},
    "message_summary": {"total": 2, "groups": [{"severity": "warning", "code": "dome.markdown.broken-wikilink", "message": "...", "count": 1}]},
    "repair_summary": {"total": 2, "groups": [{"repair_path": "link.resolve-or-create", "count": 1}]},
    "disposition_summary": {"total": 2, "groups": [{"disposition": "agent-fixable", "count": 1}]},
    "shownItems": 1,
    "omittedItems": 0,
    "items": [{"severity": "warning", "code": "dome.markdown.broken-wikilink", "message": "...", "repair_path": "link.resolve-or-create", "disposition": "agent-fixable", "source_refs": "wiki/page.md:7"}]
  },
  "decisions": {
    "questions": 1,
    "agent_safe_questions": 0,
    "model_safe_questions": 0,
    "owner_needed_questions": 1,
    "shownItems": 1,
    "omittedItems": 0,
    "items": [{"id": 42, "question": "Retry failed outbox row?", "resolveCommand": "dome resolve 42 <retry|abandon>"}]
  },
  "maintenance_loops": [
    {
      "id": "dome.question.continuity",
      "state": "attention",
      "processor_ids": ["dome.health.outbox-recovery-questions"],
      "required_processor_ids": ["dome.health.outbox-recovery-questions"],
      "optional_processor_ids": [],
      "diagnostics": 0,
      "attention_diagnostics": 0,
      "drift_diagnostics": 0,
      "noise_diagnostics": 0,
      "questions": 1
    }
  ],
  "next_actions": [
    {"reasons": ["engine"], "command": "dome sync --json"},
    {"reasons": ["diagnostics"], "command": "dome check --content --attention --limit 50 --json"},
    {"reasons": ["questions"], "command": "dome resolve 42 <retry|abandon>"}
  ]
}
```

`dome check` does not mutate state and does not run the compiler. When the
report says engine work may be recoverable through a health question, run
`dome sync --json` or keep `dome serve` running, then rerun `dome check --json`.
`next_actions` orders safe/autonomous actions before unresolved decision actions:
engine sync first, source-diagnostic review/fix paths second, unresolved
questions last. Open questions do not block unrelated sync or garden progress.
Every decision item includes its own `resolveCommand`. The
question next-action mirrors the first unresolved decision; when that decision
has explicit options, the command includes them as the placeholder, for example
`dome resolve 42 <retry|abandon>`; free-form decisions use `<answer>`.
For `agent-safe` and `model-safe` rows, a vault-aware agent may run
`resolveCommand` when the answer is grounded in the row's SourceRefs, current
adopted vault context, and allowed options. `recommended_answer` is only a
hint. `owner-needed` rows, and rows missing metadata, should be surfaced to the
owner instead of guessed.
When attention diagnostics are present and not already bounded, the diagnostic
next action points to `dome check --content --attention --limit 50 --json` so
an agent can safely fetch a larger bounded actionable detail list before
editing source markdown.
Once `dome check` is already rendering an attention-filtered content report,
the diagnostic next action is manual (`command: null`) and tells the caller to
fix the listed source markdown diagnostics, commit, and run `dome sync --json`;
it must not route back to the same bounded check command. Text renderers display
null-command actions as `manual: <description>` while JSON keeps the stable
`command: null` shape.

### `dome resolve <question-id> [<value>]`

The normal decision channel for QuestionEffects. `<question-id>` is the row id
shown by `dome check`; `<value>` is one of the question's options when options
are present, or free-form text otherwise. Without `<value>`, `dome resolve
<question-id>` prints the question and options.

`dome resolve` may be run by the owner or by a vault-aware foreground agent.
Agent resolution is valid only for `agent-safe` / `model-safe` questions whose
answer is grounded in the question SourceRefs and current adopted vault
context. The command is intentionally still the only mutation path: agents must
not edit `.dome/state/` directly, even for low-risk questions.

`dome resolve` delegates to the same durable answer machinery as `dome answer`:
it records the answer, marks the projection row resolved, and dispatches
matching garden-phase answer handlers. The dedicated verb exists so the
primary path reads naturally: `status` routes, `check` explains, `resolve`
answers.

Text output uses a short `Dome Resolve: ...` headline plus `Question`,
`Summary`, and `SourceRefs` sections when printing an unresolved row. On
answer, it prints the resolved answer and answer-handler summary.

`--json` emits `dome.answer/v1` while preserving the root `status`,
`question`, and `handlers` fields used by agent callers. Error cases emit
`{ schema, status: "error", error, message }` to stdout.

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
   section: Platform Team Ownership › Decisions
   Atlas owns runtime; platform owns infrastructure boundaries...
   why: project page; 2 open loops; decision (score 17, fts -2.41)
   SourceRefs:
     - wiki/syntheses/platform-team-ownership.md:14-22 @ 41a98c2
   facts: dome.graph.tagged, dome.daily.followup x2
   diagnostics: dome.markdown.broken-wikilink
   Questions:
     - [#42] Possible follow-up in wiki/syntheses/platform-team-ownership.md:19...
       resolve: dome resolve 42 <track|ignore>

2. 2026-05-23 (wiki/dailies/2026-05-23.md)
   Discussed platform ownership with Danny...
   SourceRefs:
     - wiki/dailies/2026-05-23.md:48-52 @ 41a98c2

(more adopted-state matches exist; increase --limit to show more)
```

`--json` emits the structured `dome.search.query/v1` payload. Every match
carries SourceRefs because the search-document rows are written from
SearchDocumentEffect. FTS rows are heading-section granular (per
[[wiki/specs/projection-store]] §"fts_documents"); the processor collapses
section hits to the best section per page and each match carries that
section's `sectionId` and `breadcrumb` (`<page title> › <heading path>`) plus
section-ranged SourceRefs. Text mode prints the breadcrumb as the `section:`
line when the best hit is a non-intro section. The processor fetches an
expanded FTS candidate set and
also recalls exact-path documents when projection memory has a topic-matched
open loop, decision, unresolved question, or active diagnostic for that page.
It also expands one hop over `dome.graph.links_to` facts from the top FTS
pages (pages linked from or linking to those hits, ordered by the rank of the
linking hit) and fuses the FTS and link-expansion channels with reciprocal-
rank fusion (k=60, link channel at half weight). The fused contribution lands
as `fusion`-kind ranking signals ("text match", "linked from matches"), so a
page that never matched FTS can enter the candidate set through links but
cannot outrank a direct strong hit for an exact-term query on fusion alone.
Daily-intent queries such as "today", "daily", "yesterday", "tomorrow", or an
explicit `YYYY-MM-DD` also recall existing date-named markdown files for that
day from the adopted snapshot. This makes the current daily note available as a
read-first candidate even when its body does not literally match the user's
natural-language query.
When that daily-intent recall resolves a target daily surface, historical
date-named daily notes are filtered out of FTS and projection-recall candidates
unless they are the target daily. This prevents old daily notes that merely say
"today" from crowding out the current daily surface and its backing context.
It then ranks the combined candidate set before slicing to `--limit` with
source-backed signals: page type, graph facts, open-loop facts, decisions,
unresolved questions, active diagnostics, projection recall signals, and the
RRF fusion signals described above. The
legacy `rank` field remains the raw FTS rank for FTS matches; recalled
documents use a deliberately weak FTS rank and are promoted only by recall and
related-state signals. After ranking, a recency decay pass multiplies the
composite score of the top ~25 candidates by
`max(0.35, 0.995^hoursSince(lastHumanChangedAt))` — old-but-relevant pages
are dampened toward the floor, never buried, and Dome-authored engine commits
do not refresh recency because the basis is `lastHumanChangedAt` (pages whose
history is entirely Dome-authored are not decayed). The `ranking` object
carries `score`, `ftsRank`, `recencyFactor`,
human-readable `reasons`, and structured `signals` so agents can explain why a
result was promoted. Matches also include related page facts and unresolved
diagnostics/questions whose SourceRefs point at the matched path. Open
questions include durable row ids, options, and a ready-to-run `dome resolve
<id> <value>` hint so recall can explain relevant engine state without forcing
an immediate `inspect` detour. The top-level `limit`, `shown.matches`, and
`hasMore.matches` fields describe bounded result rendering; when more visible
matches are detected, text mode prints the expansion hint above.
Text mode summarizes repeated fact predicates and diagnostic codes with counts
(`xN`) so multi-link or multi-task pages remain scan-friendly. JSON keeps the
underlying row shape but bounds per-match related facts, diagnostics, and
questions to the top topic-relevant rows; exhaustive provenance remains
available through `dome inspect facts`, `dome inspect diagnostics`, and
`dome inspect questions`.

### `dome lint [--fail-on <severity>] [--limit <n>] [--json]`

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
without making the command fail. `--limit` bounds the rendered issue rows while
leaving the severity counts and exit threshold based on the full adopted-state
issue set; omitted issue counts tell the user how to expand the report.
`--json` emits the structured `dome.lint.report/v1` payload with the same
status, counts, checked-file summary, bounded `issues`, `shownIssues`,
`omittedIssues`, and SourceRefs.

### `dome export-context <topic> [--limit <n>] [--json]`

Dedicated wrapper for the `dome.search.export-context` view processor. It uses
the same adopted-state retrieval substrate as `dome query`, then renders a
portable markdown packet for another Claude session, review, or handoff.

Default text output is the markdown packet itself. It starts with an overview:
read-first paths, topic-relevant source-backed open loops, source-backed
decisions, unresolved questions with automation policy metadata and
`dome resolve` hints, active diagnostics, and recall signals that explain
projection-memory matches.
It then includes matching paths,
source-backed summaries, snippets, related facts, related diagnostics, related
open questions, and SourceRefs per match. Each summary row is derived only from
the match snippet or source-backed facts/questions/diagnostics and carries its
own SourceRefs, giving foreground agents a compact read-first reason without
introducing an LLM-generated claim. Overview and summary rows prefer related
items whose text overlaps the requested topic, falling back to generic related
items only when a matched page has no topic-overlapping related memory.
Per-match related fact, diagnostic, and question sections are bounded in the
rendered packet and include omitted-row hints when more related rows remain;
structured JSON entries use the same bounded, topic-prioritized related arrays
so `--json` stays useful as a foreground-agent handoff packet instead of an
exhaustive fact dump. Consumers that need all evidence should use
`dome inspect facts`, `dome inspect diagnostics`, or `dome inspect questions`.
Daily task facts use the same display convention as the daily action view:
parsed `📅` due-date and priority glyph markers are rendered as bracketed
`due` / `priority` metadata instead of duplicated inside the task text.
Search-match entries use the same expanded candidate ranking as `dome query`:
section-granular FTS hits collapsed to the best section per page (entries
carry `sectionId` + `breadcrumb`, and the rendered packet prints the
breadcrumb as a `Section:` line), one-hop `dome.graph.links_to` expansion
fused via reciprocal-rank fusion (k=60), and the top-N recency decay pass.
The packet can
also recall exact-path documents when projection memory has a topic-matched
open loop, decision, unresolved question, or active diagnostic for that page,
even if the page body itself did not match the FTS query. Daily-intent packets
also recall existing date-named markdown files for the requested day from the
adopted snapshot, so a foreground agent asking what to work on today sees the
current daily surface as an explainable read-first entry. When the requested
daily surface exists, historical date-named daily notes are filtered out of the
packet's FTS and projection-recall candidate set unless they are that requested
surface. This keeps old notes that happen to contain the word "today" from
occupying read-first slots ahead of active backing context. These daily-intent
packets also parse the recalled daily surface's hand-authored open checkboxes,
directives, and generated source-backed open-loop rows into the overview's
`Open Loops` section, preserving both the daily surface line SourceRef and the
backing source SourceRef for generated rows. Read-first reasons, per-entry
`Ranking` lines, and the overview's `Recall Signals` section expose the
source-backed signals that promoted an entry. Entries are also
bounded by `--limit`; the structured JSON includes `shown.entries`,
`hasMore.entries`, `overview`, per-entry `ranking`, and text mode prints an
expansion hint when more adopted-state matches are detected. `--json` emits the
structured `dome.search.export-context/v1` payload, including the packet under
`markdown`; `entries[].summary` carries the source-backed compact summaries, and
`overview.recallSignals` carries the same source-backed recall evidence for
structured consumers.

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

### Run-only daily view processors

The target daily-note path comes from `dome.daily` extension config. Default is
`wiki/dailies/{date}.md`; vaults that keep Obsidian daily notes at the root of
`notes/` can set:

```yaml
extensions:
  dome.daily:
    config:
      daily_path: notes/{date}.md
```

`dome run today --date <YYYY-MM-DD> [--limit <n>] [--json]` exercises the
`dome.daily.today` view processor for deterministic debugging. It is not a
dedicated daily workflow command; the primary V1 workflow should use the
prepared daily markdown surface plus `dome query` / `dome export-context`.

Its text output renders:

- the target date and expected daily-note path,
- whether that daily note exists at the adopted ref, plus the daily-note vs.
  wider-backlog count split,
- due-bucket counts for open tasks and followups (`overdue`, `today`,
  `upcoming`, `undated`) before the long row lists,
- source-backed open tasks and followups from `dome.daily.open_task` /
  `dome.daily.followup` facts,
- unresolved `dome.daily.*` questions with durable row ids, options, and
  `dome resolve <id> <value>` hints.

Daily action fact text is semantic task text: leading `#task`, `#followup`,
and `#follow-up` marker tags are stripped from rendered task/followup text.
Parsed Obsidian Tasks metadata markers such as `📅 YYYY-MM-DD` and priority
glyphs are also stripped from display text once represented in structured
`dueDate` / `priority` fields. SourceRefs still point to the original markdown
line, and source-backed open loops also carry a stable SourceRef id derived
from normalized source path + semantic action text so moving a task line does
not create a new open-loop identity.

The `dome.daily.carry-forward` garden processor may write small generated
blocks into the current daily note: a `## Start Here` context block derived
from yesterday's daily note, and a `## Open Loops` block derived from
source-backed actions. Schedule runs target the scheduled fire date; signal
runs target the compiler host's current date. Changed historical daily notes
are evidence, not mutation targets. `dome.daily.task-index` treats those blocks
as surfaces, not new sources: generated daily entries are skipped during fact
extraction, but `today` and `prep` still read open source-backed rows as the
target day's surface. Carry-forward keeps existing generated rows in place when
their backing source item is still live, then fills any remaining slots from the
freshly ranked candidate set. This gives the daily cockpit stable same-day
ordering without letting completed or deleted source items linger. When the same
loop also exists as an original project, meeting, capture, or prior-daily fact,
the view folds the rows together, counts the representative as `daily`, and keeps
representative source refs for the daily surface plus the backing source.
Rendered daily/prep/agenda rows use the compact `evidenceLabel` from that folded
evidence: a generated daily row can display `daily.md:24; source project.md:8`
instead of hiding the backing source behind a separate SourceRefs section.

Settling a generated source-backed item is still meaningful markdown evidence.
On the next carry-forward pass, Dome keeps `[x]` rows under
`### Resolved Today` and `[-]` rows under `### Dismissed Today` in that daily
note. Both states suppress the same source/body identity and equivalent
repeated surface loops from future daily surfaces. This lets the daily note act
as a collaborative work queue without mutating the original source note or
storing hidden dismissal state in `.dome/state`.

Within daily action sections, each task/followup/question carries a source
scope: `daily` when it comes from the target daily note, `backlog` otherwise.
Repeated task/followup facts with the same semantic surface key, plus
conservative near-duplicate open-loop rows, fold into one display row before
counts and limits are computed; the representative keeps the best source ref
per source path so agents can inspect the display row and backing source without
duplicated page-level refs. Items from
the target daily note sort before the wider vault backlog and preserve source
line order. Wider-backlog task and followup rows then sort by explicit action
metadata before recency and path / line / text: due dates on or before the
target day first, priority-only rows next, future-dated rows after that, and
undated/unprioritized rows last. Within the same metadata bucket, overdue rows
closest to the target day sort before older overdue rows, future rows sort
soonest first, and rows from more recently changed source files sort before
older source files. Priority markers use the Obsidian Tasks emoji order
(`highest`, `high`, `medium`, `low`, `lowest`); due dates use `YYYY-MM-DD`
values following the `📅` marker. Text mode renders the
daily-note and backlog groups separately so a large management vault does not
make today's own plan indistinguishable from long-running project/entity task
debt.

`--limit` bounds open-task, followup, and question rows per source group while
preserving total counts, so real management vaults with large task backlogs
stay readable without hiding the target daily note or the wider backlog
entirely. For each action category, the processor selects up to `<limit>`
`daily` rows and up to `<limit>` `backlog` rows after folding and sorting.
Text mode renders omitted-row hints per source group; JSON `shown` / `omitted`
fields report the actual bounded array lengths and may show more than
`<limit>` rows for a category when both source groups have matching items.
`--json` emits the structured `dome.daily.today/v1` payload, including
`sourceCounts`, `dueCounts`, `shown`, `omitted`, plus per-item `source`,
`dueDate`, `priority`, `lastChangedAt`, `evidenceLabel`, and the folded row's
complete `sourceRefs`. `shown` and `omitted` mirror the bounded arrays so
agents do not need to infer truncation from array lengths. `--date` is for
reviewing another day and for deterministic tests; omitted means local today.

`dome run prep --date <YYYY-MM-DD> [--limit <n>] [--json]` exercises the
`dome.daily.prep` view processor. It uses the same source-backed daily action
state as `dome run today`, then renders a portable planning packet for the
target day. V1 keeps it as a debug/test view; normal planning and meeting-prep
context should come from prepared daily markdown plus `query` /
`export-context`.

Default text output is markdown:

- the target daily note path and whether it exists,
- counts for open tasks, followups, and daily questions, including the
  daily-note vs. wider-backlog source split,
- due-bucket counts for open tasks and followups, so a large backlog's urgent
  shape is visible before the detailed sections,
- a prioritized "Start Here" section that lists followups first, unresolved
  daily questions second, and other open tasks third,
- bounded followup / task / question sections, with omitted-item hints when a
  section is truncated; these sections do not repeat items already shown in
  "Start Here", and instead render an "already listed" count for those rows,
- SourceRefs for the backing daily note and the rendered facts/questions.

The shared daily action model is the same as `dome run today`: each
task/followup/question carries a `daily` or `backlog` source scope, items from
the target daily note appear before wider vault backlog within each bounded
action section, wider-backlog task/followup rows use the same due-date /
priority / recency ordering, and the "Start Here" buckets preserve their
followup / question / task priority on top of that source ordering.

Daily question rows in the markdown packet include the same durable row id and
`dome resolve <id> <value>` hint as `dome check`, so a planning packet can be
acted on without a separate diagnostic command when the decision is clear.

`--limit` bounds the prioritized start list and samples detailed action
sections per source group, using the same "up to `<limit>` daily rows plus up
to `<limit>` backlog rows" rule as `dome run today`. Detailed sections do not
repeat rows already shown in "Start Here"; they render an "already listed"
count and then show the remaining bounded rows by source group. The markdown
packet's SourceRefs section is bounded by the rendered planning/action scope.
`--json` emits the structured `dome.daily.prep/v1` payload, including
`dueCounts`, `shown` / `omitted` counts for the bounded start list and action
sections, task-derived `dueDate` / `priority` / `lastChangedAt` metadata,
compact `evidenceLabel` values, plus the markdown packet under `markdown`.
`--date` is for prepping a chosen day and for deterministic tests; omitted
means local today.

`dome run agenda-with <person-or-topic> [--date <YYYY-MM-DD>] [--limit <n>]
[--json]` exercises the `dome.daily.agenda-with` view processor. It reuses the
same source-backed daily action state as `dome run today` / `dome run prep`,
filters open tasks, followups, and unresolved daily questions by the supplied
person or topic, and joins adopted-state search matches when `dome.search` has
populated the projection. For V1 user/agent workflow, a natural-language
`export-context` or `query` request is preferred because the foreground agent
can interpret the returned context instead of relying on a deterministic agenda
filter.

Default text output is markdown:

- the date context and daily note path,
- matching open agenda items with source labels, preserving total agenda-item
  counts and omitted-item hints when `--limit` truncates the section,
- matching unresolved questions with durable row ids and `dome resolve` hints,
- adopted-state context snippets for the person/topic,
- SourceRefs for the backing facts, questions, and search entries.

`--limit` bounds rendered agenda items and context matches. Agenda-item counts
remain total counts from the source-backed daily action state; context counts
are rendered context matches from adopted-state search. When the context search
has more visible matches beyond the limit, text output prints an expansion hint
and JSON sets `hasMore.context: true`. `--json` emits the structured
`dome.daily.agenda-with/v1` payload, including task-derived `dueDate` /
`priority` metadata, compact `evidenceLabel` values, and the markdown packet
under `markdown`. `--date` provides daily-note context; omitted means local
today.

### `dome rebuild`

Wipes `<vault>/.dome/state/projection.db` and rebuilds from the adopted commit per [[wiki/specs/projection-store]] §"Rebuild path". The run ledger (`runs.db`) and outbox (`outbox.db`) are preserved. Text output is intentionally terse:

```text
Dome rebuild: rebuilt projections

Summary
  branch      main
  adopted     41a98c2
  files       234
  processors  9
  effects     812
```

`--json` emits `dome.rebuild/v1` with `{ schema, status, branch, adopted,
files, processors, effects }` on success or `{ schema, status: "error",
branch, adopted, error }` on failure.

Exit codes: 0 on success; 1 on rebuild/runtime failure; 64 (EX_USAGE) on
detached HEAD or uninitialized adopted ref.

### `dome inspect <subject> [--limit <n>] [--model] [--json]`

Read-only view over the operational substrate. The command opens the
runtime (so the operational databases are initialized) but does not submit a
Proposal, does not invoke any processor, and does not mutate state.

Subjects (v1.0):

- `bundles` — configured and loaded extension bundle summary: enabled/disabled
  status, loaded flag, inventory source (`loaded`, `manifest`, `configured`,
  or `manifest-error`), version, processor counts by phase, command-view count,
  schedule count, model-capable processor count, and bundle-level model status
  (`none`, `disabled-no-provider`, `disabled-provider-configured`,
  `declared-ungranted`, `granted-no-provider`, or `ready`). Disabled
  configured bundles are summarized from their manifest without importing
  processor modules, so optional features such as `dome.agent` are visible
  without making disabled bundle code part of the runtime.
- `processors` — loaded processor/automation summary: bundle, phase, triggers,
  command names, declared capability kinds, bundle grant kinds, effective grant
  scopes, execution class, and model status (`none`, `declared-ungranted`,
  `granted-no-provider`, or `ready`). JSON rows include both compact
  `grant_scopes` text and structured `grant_details` entries so broad grants
  such as `read:**` or `patch.auto:**/*.md` are inspectable without opening
  `.dome/config.yaml`.
- `runs` — recent processor runs from `runs.db`.
- `patches` — patch capability-use rows joined to their processor run,
  including run id, processor id, phase/status, patch capability, outcome,
  touched path resources, input/output commits, effect-hash count, and
  timestamps. This is the direct provenance path for generated markdown
  changes: git trailers remain the durable commit surface, and the ledger
  gives the processor/run/capability side of the audit.
- `facts` — current fact rows from `projection.db.facts`, including subject,
  predicate, object, assertion/confidence, emitting processor id, adopted commit,
  written timestamp, and compact SourceRef locations. This is the direct
  provenance path for generated memory when `query` or `export-context` shows a
  fact that needs inspection.
- `diagnostics` — current unresolved diagnostics from
  `projection.db.diagnostics`, including compact SourceRef locations so Claude
  can jump directly to affected markdown.
- `questions` — durable questions from `projection.db.questions`, including
  row id, status, options, answer, timestamps, and idempotency key.
- `outbox` — pending / failed external actions from `outbox.db`.
- `quarantine` — quarantined processor triggers from processor execution state,
  including the `quarantine_id` generation token used for safe reset.

`--limit <n>` caps the row count. Operational row subjects default to 20;
`bundles` and `processors` default to the full loaded runtime set because they
are bounded by enabled extension metadata rather than unbounded operational
history. `--model` is valid for `bundles` and `processors`: on `bundles` it
shows bundles that declare model-capable processors, including disabled
manifest-only bundles; on `processors` it shows currently loaded processors
whose model status is not `none`. `--json` emits structured rows for
cross-tool consumption.

For noisy real vaults, `dome inspect diagnostics` also accepts
`--summary`, `--severity <info|warning|error|block>`, `--code <code>`, and
`--processor <id>`. `--summary` groups unresolved diagnostics by
severity/code and includes the first message and SourceRef example for each
group; `--limit` caps groups in summary mode. The filter flags apply to both
row and summary output. `--summary`, `--severity`, and `--code` are
diagnostic-only flags so `dome inspect runs --summary` is a usage error rather
than a silently ignored option. `--processor <id>` is also valid for
`dome inspect patches`, where it filters generated patch provenance by emitting
processor.
`dome inspect facts` accepts `--predicate <predicate>` plus
`--subject-kind <page|task|entity>` and `--subject-id <id>` when a caller wants
to inspect facts for a specific page, task, or entity. `--subject-kind` and
`--subject-id` must be provided together. Fact filters are fact-only flags, so
`dome inspect runs --predicate dome.graph.links_to` is a usage error.
`dome inspect processors --model --json` is the authoritative CLI answer for
whether the currently enabled vault automation has LLM/model-capable
processors. `dome inspect bundles --model --json` is the broader inventory
answer for optional configured bundles such as disabled intake.

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
processor capability kinds that are declared but not granted. It also reports
enabled/granted model-capable processors when the vault has no configured or
host-injected model provider, and — when both `dome.daily` and `dome.agent`
are enabled — a `config.daily-path-mismatch` warning when the two bundles'
`daily_path` config keys diverge (the morning brief and create-daily would
target different files; see [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`").
The implementation lives in `src/engine/health.ts`.

**Model-provider probe.** When `.dome/config.yaml` carries a
`model_provider: { kind: "command", ... }` stanza, `dome doctor` additionally
probes the provider command by spawning it from the vault root and writing a
`dome.model-provider.probe/v1` envelope on stdin (see [[wiki/specs/capabilities]]
§"model.invoke" for the envelope contract; the probe is cheap by construction —
a conforming provider answers without any network or paid API call). The prober
(`probeCommandModelProvider` in `src/engine/command-model-provider.ts`)
distinguishes five outcomes:

- **responsive** — exit 0 with a valid probe response. Healthy; additionally,
  when the response carries `keyPresent: false`, doctor raises a
  `model.provider-key-missing` warning (configured and spawnable, but the
  provider's credential env var — `ANTHROPIC_API_KEY` for the shipped
  template — is not set in the daemon's environment). Key presence is
  reported separately from reachability.
- **probe-unsupported** — the command started, read the envelope, and exited
  non-zero (e.g. a hand-written pre-probe provider rejecting an unknown
  schema). Treated as alive; no finding. Text output still renders a muted
  "Model provider" info line with the exit code and stderr excerpt — a
  crashed provider answers exactly like a pre-probe one, so the outcome must
  be visible even though it is not classified as a failure.
- **spawn-failed** — the command could not be started at all. Raises a
  `model.provider-unreachable` error finding.
- **invalid-response** — exit 0 but stdout was not a valid probe response.
  Raises `model.provider-unreachable`.
- **timed-out** — no exit within the probe timeout (default 8s). Raises
  `model.provider-unreachable`.

The probe runs only in `dome doctor` (the probe verb); `dome check` reuses the
same `HealthReport` machinery but does not spawn the provider. Together with
the existing `model.provider-missing` finding this makes the historical silent
no-op loud: unconfigured, configured-but-dead, and configured-but-keyless
vaults each get a distinct, actionable diagnostic line.

**Current behavior.** `dome doctor` opens the runtime, collects a
`HealthReport`, prints a compact text report, and exits 0. `--json` emits the
same report with `status`, `summary`, and `findings` (summary counters include
`modelProviderMissing`, `modelProviderUnreachable`, and
`modelProviderKeyMissing`). `--repair` exits 64
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
  QuestionEffect → user runs `dome resolve <id>` → answer-handler
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
the primary `status` / `check` / `resolve` path, with `inspect` and
`doctor` retained as advanced detail views.

### `dome answer <question-id> [<value>]` *(advanced compatibility alias)*

The low-level compatibility alias for `dome resolve`. Existing scripts and
older docs may still call `dome answer`; the implementation is the same
durable answer channel for QuestionEffects the engine has raised.

**Why a single answer surface (not per-substrate verbs).** The engine
already has a primitive for "I need a durable decision" — `QuestionEffect`
in the closed taxonomy at [[wiki/specs/effects]] §"QuestionEffect".
When operational substrate gets stuck (outbox row terminally failed,
processor quarantined, orphaned running row, or similar recoverable state),
the natural pattern is:

1. **A scheduled garden-phase processor in `dome.health`** reads the relevant
   operational substrate through a scoped `ctx.operational` query view
  (for example failed outbox rows via `outbox.read` or quarantines via
  `quarantine.read`).
2. **That processor emits a `QuestionEffect`** with options (for example
   `["retry", "abandon"]`), an idempotency key that names the stuck row and
   failure instance, and `sourceRefs` pointing at the substrate row's origin.
3. **Owner or agent runs `dome check --json`** to see pending questions and
   their automation policy.
4. **Owner or agent runs `dome resolve <question-id> retry`** to resolve when
   the answer is grounded; owner-needed questions are surfaced instead.
5. **A second garden-phase processor in `dome.health`** declares an
   `answer` trigger bound to both the emitting question processor and the
   idempotency-key prefix, receives `{ question, answer }`, looks up the
   question's `idempotencyKey` → operational target, and emits the appropriate
   recovery effect to mutate the engine-owned operational state.

The primary CLI surface is one verb (`dome resolve`); the per-substrate logic
lives in the `dome.health` bundle's answer-handler processors. Adding
a new operational mutation type is one new question-emitter + one
new answer-handler in the bundle; no new CLI command.

**Design (complete v1).** `<question-id>` is the question row's id (from
`dome check`). `<value>` is one of the question's options
(when `options` is set) or free-form text (when `options` is null).
Without `<value>`, `dome resolve <question-id>` prints the question and its
options; the compatibility alias `dome answer <question-id>` does the same.

Answering writes the durable answer to `answers.db.question_answers`, updates
the current `projection.db.questions` row for inspect/query ergonomics, and
dispatches garden-phase processors with `answer` triggers. The relevant
answer-handler processor catches the answer event and applies the mutation
through normal Effect routing. Operational recovery answer handlers must match
the question's originating `processorId` as well as its idempotency-key prefix;
this prevents a third-party question emitter from invoking a first-party
handler that holds recovery capabilities.

**Current behavior.** `dome resolve` / `dome answer` looks up the row id,
prints the question when `<value>` is omitted, validates `<value>` against
`options` when options are present, records the answer, and dispatches matching
garden-phase answer handlers. Duplicate-detection content questions plus a
fixture answer handler
are covered end-to-end by the harness.

`--json` emits `dome.answer/v1`, the same envelope as `dome resolve`. Success
payloads preserve the root `status`, `question`, and `handlers` fields; usage,
lookup, runtime-open, and unexpected failure paths return structured error
payloads when `--json` is set.

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

### `dome serve [--vault <path>] [--bundles-root <path>] [--daemon] [--poll-interval-ms <n>] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]`

Runs the local compiler host — the canonical write path per [[v1]] §13.2 ("Claude Code edits project notes"). The user commits markdown via `git commit` (directly or via their harness's native write tool); the host catches up by adopting the new HEAD.

Composition (v1.0):

1. `openVaultRuntime({vaultPath, bundlesRoot, additionalBundlesRoots})` opens the operational databases (`projection.db`, `answers.db`, `outbox.db`, `runs.db`) and loads extension bundles from the resolved root set (SDK-shipped `assets/extensions/` by default, plus vault-local `.dome/extensions/` when present; `--bundles-root` replaces the set).
2. Resolves the initial branch via `getCurrentBranch`. A detached HEAD is a startup error (the adopted-ref substrate requires a branch).
3. Polls `refs/heads/<branch>` every `--poll-interval-ms <n>` (default 500ms). On each tick, compares HEAD to `refs/dome/adopted/<branch>`:
   - If the adopted ref is uninitialized: runs an empty-diff `(HEAD, HEAD)` adoption to initialize it.
   - If HEAD equals the adopted ref: no adoption work; quiet in-sync ticks may still run due operational work on the host's internal cadence.
   - Otherwise: constructs a `manual`-source Proposal via `makeManualProposal({base: adopted, head: HEAD, branch})` and routes it through the engine's `adopt()`.
4. Before adopting a drift range that touches runtime inputs
   (`.dome/config.yaml`, `.dome/model-provider.ts`, or vault-local
   `.dome/extensions/**`), closes and reopens the runtime. This makes extension
   activation, grant changes, model-provider changes, and vault-local bundle
   changes take effect without restarting the long-running host. If reload
   fails, adoption pauses and retries on later polls instead of compiling the
   new commit range with stale runtime state.
5. Adoption runs; effects route through `buildSqliteSinks` (projection + outbox writes) + the engine's candidate-tree `applyPatch` sink. View delivery remains a placeholder sink in v1.0.
6. Every adoption or operational-work pump acquires the same branch-level compiler-host lock that `dome sync` uses. A second host does not race the first; it reports busy and retries on the next poll.
7. After an adoption finishes, `serve` checks drift again before sleeping. If HEAD moved while adoption was active, the next adoption starts immediately rather than waiting for the full poll interval. This coalesces stacked commits without overlapping compiler work.
8. The host also runs operational-work pumps while HEAD is already in sync, on a quiet internal cadence. This is how schedule triggers, durable jobs, opt-in low-risk question auto-resolution, and outbox retries that become due solely because time passed make progress in a quiet vault. Default output stays silent; `--verbose` may print counts.
9. The host refreshes `.dome/state/serve-heartbeat.json` so `dome status`
   can report whether the local compiler appears `running`, `stale`, or
   `off`. The heartbeat is observability only; the branch-level compiler-host
   lock remains the concurrency guard.
10. Stays running until SIGINT / SIGTERM; on shutdown, retryable in-flight
   outbox handler attempts receive the host cancellation signal and remain
   pending without consuming retry budget, then the host closes the runtime
   (releases the projection, answers, ledger, and outbox SQLite handles) and
   exits 0.

`--quiet` suppresses routine text output: startup banner, successful adoption
summaries, operational-work summaries, and shutdown line. It still reports
startup failures, detached-HEAD pauses, blocked adoption diagnostics, and
unexpected tick errors. `--quiet` and `--verbose` are mutually exclusive.

`--daemon` starts the same compiler host in a detached background process and
returns after the heartbeat proves the child is running. The child writes its
routine output to `.dome/state/serve-daemon.log` unless startup fails before
that path is available. If a same-branch host is already running, daemon mode
exits 0 and reports the existing pid; if another branch owns the running
heartbeat, daemon mode exits 1 rather than starting an ambiguous host. This is
the copyable session-start shape used by V1 dogfood preflight; a plain
foreground `dome serve` remains useful when an operator wants the live log in a
terminal.

`--verbose` prints adoption-loop progress events. `--filter-processor <glob>`
narrows those verbose events to matching processor ids, for example
`dome serve --verbose --filter-processor 'dome.markdown.*'`. It filters only
observability output; it never changes which processors run.

The watcher mechanism is **poll-based** (not filesystem-event-based). Poll is simpler than `fs.watch` on `.git/refs/heads/<branch>`, requires no extra dependencies, and 500ms latency is invisible to a user committing markdown. The v0.5 chokidar-over-`wiki/` watcher was retired with the v1.0 substrate migration — adoption is keyed off git commits, not raw file writes, so the watch target is a ref (one file) rather than the whole vault subtree.

The scheduled-trigger dispatcher for garden processors is wired through the same runtime grant resolver as adoption. View processors are command-driven in v1 because scheduled views have no caller-owned delivery surface. There is no separate `serve --exclusive` flag in v1 because branch-level locking is always on. There is no `serve --mcp` toggle: the MCP server is its own verb (`dome mcp`) because serve is the compiler host while MCP is a read/capture protocol adapter — they compose by running both.

Exit codes: 0 on graceful shutdown; 1 on startup error (detached HEAD, runtime open failure, malformed `--poll-interval-ms`).

### `dome install [--vault <path>] [--status] [--env KEY=VALUE]... [--env-file <path>] [--json]`

Makes the local compiler host **ambient** on macOS: generates a launchd
LaunchAgent that runs `dome serve` for the vault at login, keeps it alive
across crashes and reboots, and loads it immediately via `launchctl`. This is
the Phase 1 wedge enabler ([[wedge]] §"Phase 1 — Ambient daemon"): scheduled
garden processors fire without a human keeping a terminal or tmux pane open.

Composition (v1.0):

1. Resolve `vaultPath` (default cwd) and the deterministic service label
   `com.dome.serve.<slug>`. `<slug>` is the lowercased vault basename with
   non-`[a-z0-9-]` runs collapsed to `-`, plus the first 8 hex chars of the
   SHA-256 of the resolved vault path. The same vault path always yields the
   same label; distinct vaults never collide, so one machine can run one
   ambient host per vault.
2. On non-macOS platforms, refuse with exit 1 and the message "launchd service
   install is macOS-only; run `dome serve` under your service manager". No
   plist is written and no service manager is touched.
3. Precondition: the target must be an initialized Dome vault — a git
   repository with `.dome/config.yaml` present (same refusal style as `dome
   capture`, exit 64). Without the gate, installing against an arbitrary
   directory would scaffold `.dome/state/` there and load a KeepAlive
   service that crashloops forever.
4. Ensure `<vault>/.dome/state/` exists — the service log directory, already
   gitignored by the `dome init` scaffold.
5. Write `~/Library/LaunchAgents/<label>.plist` with:
   - `Label` — the service label;
   - `ProgramArguments` — `[<bun>, <SDK>/bin/dome, "serve", "--vault",
     <vaultPath>]`, where `<bun>` is the absolute bun runtime executing the
     install (`process.execPath`) and the dome entry script is resolved from
     the installed SDK, mirroring how `dome serve --daemon` re-invokes itself;
   - `EnvironmentVariables` — always a `PATH` whose first entry is the
     directory of the installing bun runtime, followed by the standard dirs
     (`/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`).
     launchd gui agents otherwise get a bare
     `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which cannot resolve a
     Homebrew/`~/.bun` bun — and the serve host must spawn provider commands
     like `["bun", ".dome/model-provider.ts"]`. Additional entries come from
     `--env-file <path>` (KEY=VALUE lines; blank lines and `#` comments
     skipped) then repeatable `--env KEY=VALUE` flags (flags win on the same
     key), e.g. credentials such as `ANTHROPIC_API_KEY`. All keys and values
     are XML-escaped into the plist. Malformed entries are usage errors
     (exit 64). Note that re-running `dome install` rebuilds the plist from
     the flags passed *that* run — env entries are not remembered across
     re-installs — and values live in plain text in the plist; `launchctl
     setenv` is the alternative for environment that should live outside the
     plist;
   - `WorkingDirectory` — the vault path;
   - `RunAtLoad` and `KeepAlive` — `true`;
   - `StandardOutPath` / `StandardErrorPath` — `<vault>/.dome/state/serve.log`.
6. `launchctl bootout gui/<uid>/<label>` first (failure ignored when the
   service is not currently loaded), then `launchctl bootstrap gui/<uid>
   <plist>`. The bootout-first shape makes re-runs replace the loaded service
   definition cleanly: re-running `dome install` after moving the SDK or
   changing the bun runtime is the supported upgrade path.

Idempotency: re-running `dome install` rewrites the plist and replaces the
loaded service; it exits 0. A failed `bootstrap` leaves the plist in place for
inspection, prints launchctl's stderr, and exits 1.

`--status` is the read-only service probe: it reports the label, plist path,
`installed` (plist present in the LaunchAgents dir), and `loaded` (whether
`launchctl print gui/<uid>/<label>` resolves) without mutating anything. A
loaded service also writes the normal serve heartbeat, so `dome status`
already shows `serve running` / `stale` while the agent is alive; surfacing
installed-but-dead state directly inside `dome status` is a Phase 1 follow-up
(use `dome install --status` until it lands).

`--json` emits `dome.install/v1`: `{ schema, status:
"installed" | "status" | "error", vault, label, plist, log?, installed?,
loaded?, error? }`.

Concurrency: the launchd-managed host acquires the same branch-level
compiler-host lock as every other host, so an installed service plus a
foreground `dome serve` or one-shot `dome sync` do not race — one reports
busy and retries.

Testability is part of the contract: `runInstall` / `runUninstall` accept an
injected deps object (`platform`, `uid`, `launchAgentsDir`, a `launchctl`
runner, and the bun/dome executable paths) defaulting to the real home
directory and a real `Bun.spawn` runner. Tests pass a temp LaunchAgents dir
and a recording fake runner; they never touch `~/Library` or invoke real
`launchctl`.

Exit codes: 0 on success (including idempotent re-install and clean
`--status` reads); 64 (EX_USAGE) on an uninitialized vault (missing git repo
or `.dome/config.yaml`) or a malformed `--env`/`--env-file` entry; 1 on
non-macOS platform, undeterminable uid, `launchctl bootstrap` failure, or
unexpected I/O failure.

### `dome uninstall [--vault <path>] [--json]`

Removes the vault's ambient service: `launchctl bootout gui/<uid>/<label>`
(failure ignored when the service is not loaded), then deletes the plist from
`~/Library/LaunchAgents/`. Idempotent — when no plist is present it still
attempts the bootout (covering a deleted-plist-but-loaded edge), reports "not
installed", and exits 0. The serve log at `.dome/state/serve.log` is
preserved; it is operator evidence, not service state.

Non-macOS platforms get the same macOS-only refusal as `dome install`.

`--json` emits `dome.uninstall/v1`: `{ schema, status:
"uninstalled" | "not-installed" | "error", vault, label, plist, error? }`.

Exit codes: 0 on success or already-not-installed; 1 on non-macOS platform,
undeterminable uid, or unexpected I/O failure.

### `dome mcp [--vault <path>] [--bundles-root <path>]`

Runs the Dome MCP server over stdio for one vault — the shipped protocol
adapter per [[wiki/specs/mcp-surface]] ([[wedge]] §"Phase 5 — MCP server").
The server exposes eight typed tools (`capture`, `query`, `export_context`,
`status`, `check`, `resolve`, `tasks`, `brief`) whose results are the same
JSON documents the corresponding CLI verbs emit under `--json`; the adapter
invokes the same command handlers rather than re-implementing them.

Boundary discipline:

- **stdout is the protocol channel.** The adapter captures handler
  `console.log` output per tool call (serialized behind a mutex) so command
  JSON becomes the tool result instead of corrupting the wire. Server-side
  notices go to stderr.
- **No compilation.** The MCP server runs no adoption loop or scheduler;
  `dome serve` (kept alive by `dome install`) owns that. `capture` and
  `resolve` are the only write-shaped tools and reuse the existing
  non-engine write channels (ordinary human commit; `answers.db`).
- **Static-graph hygiene.** The Commander action loads
  `src/cli/commands/mcp.ts` via dynamic import, so
  `@modelcontextprotocol/sdk` stays out of the CLI's static import graph
  (and is never reachable from `src/index.ts`, per
  [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]]).

Registration from Claude Code:

```bash
claude mcp add dome -- dome mcp --vault /path/to/vault
```

The process serves until the client disconnects (stdin closes). Exit codes:
0 on clean shutdown; 64 when the target is not an initialized Dome vault
(missing git repo or `.dome/config.yaml`); 1 on transport failure.

### Planned dedicated view aliases

`dome stats` and `dome migrate` are roadmap commands, not current Commander
bindings. The intended shape is:

- `dome stats` — richer vault analytics beyond the compact `dome status`
  dashboard.
- `dome migrate` — explicit vault/schema upgrade orchestration beyond the
  current open-time SQLite migration and projection rebuild paths.

Until these aliases ship, command-triggered view processors are invoked via
`dome run <command-name>`. The shipped run-only first-party view commands are
`dome run orphan-pages`, `dome run today`, `dome run prep`, and
`dome run agenda-with`.

## Adding a new command

The "Adding a new command" recipe parallels [[wiki/specs/sdk-surface]] §"Adding a processor" — CLI commands are command-triggered view-phase processors. A generic `dome run <name>` command needs three edits:

1. **The processor file** at `assets/extensions/<bundle>/processors/<command-name>.ts` exporting `defineProcessorImplementation({ run })`.
2. **The manifest entry** in the bundle's `manifest.yaml` declaring `phase: "view"` and `triggers: [{ kind: "command", name: "<command-name>" }]`.
3. **An end-to-end test** at `tests/harness/scenarios/cli-surface/<command>.scenario.test.ts` exercising `dome run <command-name>` against a fixture vault.

A dedicated `dome <name>` Commander binding is a fourth edit when the command
has user-facing ergonomics that justify first-class flags, help text, or text
rendering.

The CLI Commander layer is the thin protocol adapter; the work happens in the processor. Adding a command that does *not* need a dedicated `dome <name>` Commander binding is three edits — register the processor and invoke it via `dome run <command-name>`. A future `AbstractSurface` adapter should reuse the same shared dispatch boundary so dedicated view commands and generic command invocations inherit adopted-ref validation, projection freshness rebuilds, effect routing, and ledger recording consistently.

The CLI shell-shape lockstep test enumerates command-triggered processors in
`assets/extensions/dome.*/manifest.yaml` and asserts each has either a
Commander binding in `src/cli/index.ts` or a documented `dome run` invocation
in this spec.

## Why the CLI surface is tiered

The CLI is the primary v1 control surface for agentic harnesses, but the normal
Claude Code grammar is intentionally small: `serve` / `sync` drive the
compiler, `status` routes attention, `check` explains it, and `resolve` records
the user's decision. Optional view commands read adopted state when explicitly
useful. Advanced commands (`inspect`, `doctor`, `answer`, `run`, `rebuild`)
remain named because they are valuable for debugging, scripting, and extension
development, not because agents should choose among them during the daily loop.

Extension-defined view commands can start behind `dome run <name>` and
graduate to dedicated aliases once their workflow deserves first-class help
text, flags, and text rendering. This keeps the primary loop small while
leaving a clean path to richer named commands.

The MCP server (`dome mcp`, per [[wiki/specs/mcp-surface]]) is the alternative for harnesses that prefer typed read/query routing; it exposes the same command handlers as typed tools. Adoption catch-up remains CLI/git-native in v1.0.

## Related

- [[wiki/specs/capture]] — the capture loop end-to-end + the phone/voice ingress recipe behind `dome capture`.
- [[wiki/specs/sdk-surface]] §"Consumer surfaces" — the planned AbstractSurface this adapter should converge with.
- [[wiki/specs/harnesses]] — when the CLI vs MCP earns its keep.
- [[wiki/specs/adoption]] — what `dome sync` / `dome status` consult.
- [[wiki/specs/processors]] — view-phase command processors.
- [[wiki/matrices/protocol-adapter]] — CLI as one row in the adapter map.
