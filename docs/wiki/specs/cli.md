---
type: spec
created: 2026-05-27
updated: 2026-07-04
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
  - "[[v1]]"
description: "Normative command-by-command CLI spec: capture, sync, status, check, resolve, query, today, log, serve/install, mcp, http, recipe and more"
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
dome capture [text] [--file <path>] [--title <t>] [--capture-id <id>] [--json]
                                Frictionless capture: write a timestamped raw
                                source into inbox/raw/ and commit it on the
                                current branch. Returns immediately.
                                --capture-id is the retry-idempotency key: an
                                existing capture for the same id answers
                                duplicate (still exit 0), nothing written.
dome sync [--json] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]
                                Catch-up: construct Proposal from working-tree HEAD; adopt.
dome status [--loops] [--probe] [--json]
                                Vault health + content dashboard.
dome check [--engine] [--content] [--decisions] [--loops] [--attention] [--limit <n>] [--json]
                                Explain compiler attention across health,
                                diagnostics, and decisions.
dome resolve <question-id> [<value>]
                                Resolve a Dome-raised decision from `check`.
dome settle <block-id> <close|defer|keep> [--until <yyyy-mm-dd>] [--json]
                                Settle a task line by its ^block-anchor: close
                                completes it (+ a Done-today bullet), defer
                                rewrites the due date to --until, keep records
                                nothing. One human commit (none for keep).
dome query <text> [--category <c>] [--type <t>] [--limit <n>] [--json]
                                FTS + structured query against adopted state.
dome export-context <topic> [--limit <n>] [--json]
                                Portable source-backed context packet.
dome today [--date <yyyy-mm-dd>] [--limit <n>] [--watch] [--interval <seconds>] [--json] [--verbose]
                                Render today's action surface (open tasks,
                                follow-ups, questions) — the terminal cockpit.
                                --watch re-renders on an interval until ctrl-c.
dome prep [--date <yyyy-mm-dd>] [--limit <n>] [--json]
                                Deterministic source-backed planning packet for a day.
dome agenda-with <person-or-topic> [--date <yyyy-mm-dd>] [--limit <n>] [--json]
                                Deterministic open tasks, follow-ups, and context
                                filtered to a person or topic.
dome stale-claims [--json]     Claims whose *(as of)* date is older than the
                                staleness horizon (default 120 days).
dome orphan-pages [--json]     Markdown pages with no incoming wikilinks.
dome log [--since <date>] [--processor <id>] [--grep <text>] [--limit <n>] [--json]
                                Vault activity: git history joined with the
                                run ledger. Engine commit bodies carry the
                                patch narrative (log.md is frozen).
dome serve [--vault <path>] [--daemon] [--poll-interval-ms <n>] [-v|--verbose]
           [--filter-processor <glob>] [-q|--quiet]
                                Run the local compiler host. Polls refs/heads/<branch>
                                every 500ms; constructs a manual Proposal and adopts on drift.
dome install [--vault <path>] [--status] [--env KEY=VALUE]... [--env-file <path>] [--json]
                                Install `dome serve` for this vault as an ambient
                                service (macOS launchd LaunchAgent; Linux systemd
                                --user unit). Survives crashes and reboots.
dome restart [--vault <path>] [--json]
                                Restart the vault's ambient service from the
                                existing plist/unit (never re-rendered; --env preserved).
dome uninstall [--vault <path>] [--json]
                                Stop and remove the vault's ambient service.
dome mcp [--vault <path>]       Run the stdio MCP server over this vault: typed
                                read/capture tools (capture, query, export_context,
                                status, check, resolve, settle, tasks, brief) for
                                MCP harnesses. The daemon still owns compilation.
dome http [--vault <path>] [--port <port>] [--host <host>] [--token <token>]
          [--model <id>] [--static-dir <path>] [--allow-write]
          [--transcribe-cmd <cmd>] [--transcribe-key <key>]
          [--transcribe-url <url>] [--transcribe-model <model>]
                                Run the Dome HTTP surface (bearer-token auth;
                                loopback by default): read/capture/resolve/settle
                                routes, the GET /today HTML cockpit, POST /agent (the
                                hosted agent loop; converse capability),
                                POST /agent/stream (SSE variant), POST /transcribe
                                (voice STT; capture capability), and GET /recents.
                                --allow-write grants the agent the `author` write
                                capability (create_document / edit_document →
                                git commit → daemon adopts); default off,
                                read-only-safe. DOME_ALLOW_WRITE=1 is the env form.
                                The daemon still owns compilation.
dome recipe <kind> [--url <base>]
                                Print a setup recipe. v1 ships three kinds:
                                ios — voice capture via an iOS Shortcut against
                                the dome http surface, queue-first with the
                                iCloud fallback; capture-queue — the laptop-side
                                launchd drain for that queue; core-seed — the
                                owner interview that seeds core.md.
```

The CLI is the user-facing primary surface in v1. The implemented commands above map to one of:

- **Primary compiler loop:** `dome serve`, `dome sync`, `dome status`, `dome check`, `dome resolve`, and `dome settle`. `serve` is the foreground compiler host; `sync` is the one-shot catch-up path; `status` is the cheap pulse and next-action router; `check` explains remaining attention across engine health, content diagnostics, and open decisions; `resolve` records an owner or agent answer to a Dome-raised decision and dispatches answer handlers; `settle` records an owner or agent decision on an open task by its `^block-anchor` (close / defer / keep) — resolve's sibling for tasks rather than questions (§"`dome settle`").
- **Adopted-state recall surfaces:** `dome query` and `dome export-context` are the normal explicit read views when the user or a foreground agent asks for recall, planning, agenda context, or handoff material. They route through the shipped view-command boundary today and should map to `AbstractSurface.query` / command views once that planned boundary lands. `dome log` is the activity-recall sibling with a CLI-native posture (the `dome status` stance — no runtime, no view boundary): it reads git history directly and joins the run ledger (§"`dome log`"). `dome prep`, `dome agenda-with`, `dome stale-claims`, and `dome orphan-pages` are deterministic sibling views over the same view-command boundary — source-backed daily planning/agenda filters and claims/link-graph consistency audits — for the debugging, scripting, and unambiguous-filter cases where a natural-language `query` / `export-context` request isn't the goal. All four were previously reachable only through the hidden `dome run <name>` dispatcher; a feature behind a debug verb is unreachable, so they now have first-class top-level bindings like their `query` / `export-context` / `today` siblings.
- **Advanced/debug and compatibility surfaces:** `dome inspect`, `dome doctor`, `dome lint`, `dome answer`, `dome run`, `dome rebuild`, and `dome reanchor` remain available for detailed state inspection, extension development, maintenance, and explicit recovery. They are hidden from top-level help and are not the normal Claude Code workflow.

`dome doctor` is read-only in V1. The `--repair` flag is a reserved surface for
future answer-mediated mitigations and exits with usage status instead of
mutating state. Operational recovery mutations ship through `dome.health`
questions and `dome resolve`, so recovery still goes through normal Effect
routing and capability checks.
- **View-phase commands:** `dome run <name>` plus dedicated wrappers such as `dome query`, `dome lint`, `dome export-context`, `dome today`, `dome prep`, `dome agenda-with`, `dome stale-claims`, and `dome orphan-pages` — command-triggered view-phase processors invoked through the shared view-command boundary. `dome run <name>` remains available as the generic escape hatch for extension-authored view processors that have not (yet) earned a dedicated top-level verb.
- **Capture ingress:** `dome capture` — the frictionless write-side entry point ([[wedge]] §"Phase 3 — Capture loop"). It writes a timestamped raw source into `inbox/raw/` and lands it as an ordinary human commit on the current branch; adoption and `dome.agent.ingest` handle everything after the commit boundary. See [[wiki/specs/capture]] for the capture-loop spec and the phone/voice ingress recipe.
- **Lifecycle:** `dome init` — vault construction; `dome install` / `dome restart` / `dome uninstall` — ambient service lifecycle for the local compiler host (a launchd LaunchAgent on macOS, a systemd `--user` unit on Linux, both around `dome serve`, per [[wedge]] §"Phase 1 — Ambient daemon"). Schema migration is currently handled by storage open/rebuild paths; a dedicated `dome migrate` remains a v1.x roadmap item.
- **Protocol adapters:** `dome mcp` — the stdio MCP server ([[wedge]] §"Phase 5 — MCP server"; [[wiki/specs/mcp-surface]]) — and `dome http` — the HTTP read+capture+converse surface and first shipped form of the remote-capture seam ([[wiki/specs/http-surface]]). Both are thin adapters over the public `openVault` wrapper plus the protocol-neutral `src/surface/` collectors. `dome recipe` prints client-side setup text (`ios`: the queue-first iOS Shortcut against `dome http`; `capture-queue`: the laptop-side iCloud queue drain; `core-seed`: the owner interview that seeds `core.md` — §"`dome recipe`").

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

### `dome init [path] [--refresh-config] [--refresh-instructions] [--with-model-provider anthropic] [--with-source <kind>]...`

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
   and third-party bundle config. When it changes the file, it edits through
   the yaml Document API: only the inserted stanzas/keys are new text, and
   hand-written comments and formatting on untouched nodes are preserved
   (caveat: an inline comment trailing a block-collection key moves to the
   next line — never deleted). It deliberately does NOT merge new entries
   into grant lists the vault already carries — grant lists are user-owned
   config and auto-merging is too risky. The detection half lives in
   `dome doctor`'s `capability.grant-entry-missing` probe, which names the
   exact YAML each missing first-party rollout entry needs (see
   `docs/memory.md` §"Vault rollout").
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
   `maxDailyCostUsd` caps effective by default. It does not itself change
   `dome.agent`'s enablement — that bundle ships `enabled: true` unconditionally
   (product-review-3 Task 17: the brain is on by default, guarded by the
   shipped `$2.00/day` model-spend cap rather than by silence). Running
   `dome init` **without** `--with-model-provider` leaves `dome.agent`
   enabled with no model provider configured, which surfaces as a loud
   `agent.no-model-provider` warning once `dome serve` opens its runtime
   (§"`dome serve`") — never a silent no-op. `--with-model-provider` wires
   the provider the already-enabled agent processors need to actually run.
   Re-running `dome init --with-model-provider anthropic` on an existing
   vault is the supported wiring path for an already-initialized vault: the
   provider file and the `model_provider` stanza are each first-write-only,
   so the re-run adds whichever piece is missing and never overwrites a
   hand-edited provider or stanza.
4b. When `--with-source <kind>` is supplied (repeatable; shipped kinds:
   `calendar`, `slack` — any other kind is rejected with exit 64), scaffolds
   each requested source adapter: copies the shipped fetch template from
   `<SDK>/assets/source-handlers/claude-<kind>.sh` to
   `<vault>/.dome/bin/fetch-<kind>.sh` (executable) and ensures the matching
   subscription stanza exists under
   `extensions.dome.sources.config.subscriptions.<kind>` with the shipped
   default — always `enabled: false`: scaffolding is not consent
   ([[wiki/specs/sources]] §"The Slack stance"); the owner reviews the script
   and flips the flag. Both halves are first-write-only, mirroring the
   model-provider step: an existing script keeps its content and mode, and an
   existing stanza — whatever its shape or `enabled` value — is user-owned
   config left byte-untouched (in particular, a re-run **never flips an
   existing `enabled`** in either direction). Re-running
   `dome init --with-source <kind>` on an existing vault is the supported
   wiring path; on a vault with commits the resulting script + config changes
   are left **uncommitted** for the owner to review (the scaffold commit in
   step 9 only fires on a fresh repo). Stanza inserts (shared with the
   `--with-model-provider` insert and the `--refresh-config` fill) edit
   `.dome/config.yaml` through the yaml Document API and **preserve
   hand-written comments and formatting** on untouched nodes. One documented
   caveat (yaml@2.9): an inline comment trailing a block-collection key
   (`calendar: # note`) is repositioned onto the next line — never
   deleted.
5. Writes `<vault>/.gitignore` (ignores `.dome/state/` per
   [[wiki/specs/vault-layout]] §"Git repository structure"). First-write-only.
6. Writes `<vault>/core.md`, the always-loaded core memory page (per
   [[wiki/specs/vault-layout]] §"`core.md` — the core memory page"), as a
   commented skeleton: `# Core memory` plus `## Who I am`,
   `## Active projects`, and `## Standing preferences` sections, with an
   HTML comment explaining the propose-only convention (Dome agents read it
   every run but never auto-write it) and the ~6,000-character size budget
   the `dome.markdown.core-size` lint enforces. First-write-only — re-runs
   never overwrite the user's core memory. `dome recipe core-seed`
   (§"`dome recipe`") prints the owner interview that seeds the two
   owner-authored sections; `## Active projects` hosts the generated block
   `dome.agent.active-projects` maintains.
7. Writes `<vault>/preferences/signals.md`, the append-only
   preference-signal log (per [[wiki/specs/vault-layout]]
   §"`preferences/signals.md`" and [[wiki/specs/preferences]]), as a heading
   plus a commented header explaining the signal grammar. Like `core.md` it
   is owner data: first-write-only with NO refresh path — accumulated signal
   lines are never clobbered.
8. Writes `<vault>/AGENTS.md` from the shipped orientation template
   (per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]]) and
   `<vault>/CLAUDE.md` as a small Claude Code shim importing `AGENTS.md`.
   Claude Code reads `CLAUDE.md`, so the shim is part of the v1 boot
   path rather than polish. The generated instructions tell agents to inspect
   `serve_status` from `dome status --json` at session start, using
   `dome sync --json` after commits when no foreground `dome serve` host is
   running and to use `query` / `export-context` as read-first context surfaces
   for nontrivial vault work; the optional adopted-state views include
   `dome log` (the activity view). The template also carries the foreground
   "Preference signals" section — the standing instruction to append a
   well-formed signal line to `preferences/signals.md` when the owner
   explicitly expresses a durable preference or corrects agent behavior in
   conversation, never writing `core.md` or its promoted block
   ([[wiki/specs/preferences]] §"The signal convention").
   First-write-only by default — re-runs preserve
   any local edits. `--refresh-instructions` is an explicit maintenance path
   for old orientation files: it replaces the managed AGENTS scaffold with the
   current shipped template while preserving the delimited user-prose block. If
   an older AGENTS file has no delimiters, its previous content is moved into
   the new user-prose block. The same flag prepends the `@AGENTS.md` shim to
   CLAUDE.md when missing, preserving existing file content below it.
9. Creates an initial scaffold commit (`dome init: initial scaffold`)
   staging `.gitignore`, `AGENTS.md`, `CLAUDE.md`, `core.md`,
   `preferences/signals.md`, `.dome/config.yaml`, and the
   `inbox/raw/.gitkeep` + `inbox/processed/.gitkeep` keepers, plus
   `.dome/model-provider.ts` when the provider scaffold was requested and
   `.dome/bin/fetch-<kind>.sh` for each `--with-source` kind. Skipped if HEAD already resolves (re-init on a vault
   with commits is a no-op for this step — which is why §4b's changes stay
   uncommitted on an existing vault).

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
unexpected I/O failure; 64 (EX_USAGE) on malformed path argument or an
unknown `--with-source` kind.

### `dome capture [text] [--file <path>] [--title <t>] [--capture-id <id>] [--vault <path>] [--json]`

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

`--capture-id <id>` is the CLI binding of the remote-capture seam's
retry-idempotency key ([[wiki/specs/capture]] §"Retry semantics"). When given,
the id — not the title — drives the slug (same sanitization rules), and an
existing `inbox/raw/` capture whose filename slug already matches answers
**duplicate** instead of writing: exit 0, nothing written, nothing committed.
Text output prints `dome capture: duplicate of <path>`; `--json` emits
`{ "schema": "dome.capture/v1", "status": "duplicate", "vault", "path",
"capture_id" }`. Duplicate-as-success is the seam the queue drain relies on
([[wiki/specs/capture]] §"The iCloud queue fallback"): a drain re-run after a
crash between capture and queue-file delete still exits 0, so the queue file
is still deleted — never double-filed.

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

Exit codes: 0 on success (including a `--capture-id` duplicate); 64
(EX_USAGE) on empty input, text+`--file` conflict, TTY-with-no-input,
uninitialized vault, no commits, or detached HEAD; 1 on an unreadable
`--file` path or unexpected I/O failure.

### `dome sync [--vault <path>] [--bundles-root <path>] [--json] [-v|--verbose] [--filter-processor <glob>] [-q|--quiet]`

The one-shot catch-up: detect drift between the working-tree HEAD and `refs/dome/adopted/<branch>`, construct a `manual`-source Proposal, run it through the engine's adoption loop, print the result, exit. This is the manual trigger for users who don't want a `dome serve` compiler host running continuously.

Composition (v1.0):

1. Resolve `vaultPath` (default cwd) and bundle roots (default SDK-shipped `assets/extensions/` via `resolveShippedBundlesRoot()`, plus `<vaultPath>/.dome/extensions` when it exists; optional `--bundles-root` exact override).
2. Inspect drift via the shared `detectDrift` helper (same code path `dome serve` polls in a loop).
3. Branch on drift outcome:
   - **detached HEAD** → exit 64 (EX_USAGE) with a clear stderr message.
   - **no commits** → exit 64 with a stderr message asking for an initial commit.
   - **diverged** → refuse before opening the adoption loop because the adopted ref is not an ancestor of HEAD; print recovery guidance and exit 1.
   - **in-sync** → open the runtime, acquire the branch-level compiler-host lock, run one operational-work pump against the adopted commit (due schedule triggers, low-risk question auto-resolution when enabled, and outbox rows already pending before the pump started), print `dome sync: already in sync (<head> on <branch>)`, print durable attention / next-action lines when attention remains, exit 0.
   - **drift** → open the runtime, acquire the branch-level compiler-host lock, run `runOneAdoption`, then after a successful adoption run the same operational-work pump against the new adopted commit; print the result block plus durable attention / next-action lines when attention remains (or the `--json` payload), exit 0 (adopted) or 1 (blocked).
   - **busy** → another Dome host already holds the branch-level compiler-host lock; print a retryable busy message, exit 75.
4. Close the runtime on the way out.

`--json` emits a single JSON object on stdout suitable for cross-tool consumption:

```json
{"status":"adopted","branch":"main","base":"abc...","head":"def...","adoptedRef":"def...","iterations":1,"closureCommit":null,"garden":{"subProposalCount":1,"rejectedPatchCount":0,"diagnosticCount":0},"operational":{"scheduledCount":0,"outboxCount":0,"autoResolvedQuestions":0,"diagnosticCount":0},"health":{"pendingRuns":0,"orphanRuns":0,"failedRuns":0,"diagnostics":0,"contentDiagnostics":0,"unlocatedDiagnostics":0,"attentionDiagnostics":0,"questions":0,"outboxPending":0,"outboxFailed":0,"quarantined":0},"attention_required":false,"attention":[],"next_actions":[],"diagnostics":[]}
```

`status` is one of `"adopted" | "blocked" | "in-sync" | "busy" | "error"`. The `error` field is present on `"busy"` and error variants such as detached HEAD, no commits, runtime-open failure, or adopted-ref divergence.
`garden` summarizes post-adoption garden PatchEffects that spawned
sub-Proposals plus any garden-routing diagnostics. `operational` summarizes
the scheduled/outbox/auto-resolution pump. `autoResolvedQuestions` counts
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

There is no `--force-advance` flag on `dome sync`. The adopted-ref substrate's fast-forward-only check is in place; a divergent HEAD is detected by the shared compiler-host drift boundary before any Proposal is constructed and `dome sync` refuses (exit 1) with recovery guidance. The explicit recovery flow is its own verb — `dome reanchor` (below) — which backs up the old adopted SHA under `refs/dome/backup/` before accepting the rewritten HEAD; keeping the bypass off `sync` means the routine catch-up command can never be scripted into silently following a history rewrite.

Exit codes: 0 on adopted / in-sync; 1 on blocked, adopted-ref divergence, or runtime-open failure; 64 (EX_USAGE) on detached HEAD or no commits; 75 (EX_TEMPFAIL) when another compiler host holds the branch lock.

See [[wiki/specs/adoption]] §"`dome sync`" for the broader normative description.

### `dome status [--loops] [--probe] [--json]`

The health pulse for a vault. It is read-only and cheap enough for an
agent or user to run at session start/end. Status intentionally combines
the old "am I adopted?" pulse with cheap vault analytics so Claude Code
and a human operator get one useful first glance, not two separate
commands. Text mode renders a signal-first summary by default:

```text
dome status - work                                      ! 2 items need attention

  > dome sync   Run one compiler tick to adopt pending commits or drain
                due operational work.
  > dome check --content --attention --limit 50   Review bounded actionable content diagnostics; fix the source markdown issue(s), commit, then run dome sync --json.

  ! sync          needed
  ! diagnostics   12 (8 attention)
  √ projection, draft, questions, runs, outbox all clean

  --verbose for full vault + engine
```

`--verbose` expands to the full dashboard with `NEXT`, `AT A GLANCE`, `VAULT`,
and `ENGINE` sections (no footer rule). Use `--verbose` when you need the vault
path, pending commit count, service state, or the per-loop breakdown.

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
`pending_runs`, `failed_runs`, `serve_stale`, `service_not_loaded`,
`model_provider_unreachable`, `diagnostics`, `questions`,
`outbox_pending`, `outbox_failed`, `quarantined`, and
`capture_loop_inactive`. This set is closed: the `StatusReason` union in
`src/surface/attention-reasons.ts` is its canonical inventory, and the emitter
(`statusAttention`), the next-action buckets, and the CLI signal painter are all
type-checked against it, so a code cannot be added or removed without the
compiler flagging every site that must react. `adopted_ref_diverged` routes to `dome reanchor`
(inspect first; see [[wiki/gotchas/adopted-ref-divergence]]);
`service_not_loaded` routes to `dome restart`; `model_provider_unreachable`
routes to `dome doctor --json`. Dirty reasons include bounded path samples in
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
one-shot `dome sync` is a valid catch-up mode.

**Ambient service line.** `service_status` / `service_label` report the
vault's ambient service through install's probe helpers (the same
injected `ServiceDeps`, so tests use the recording fake): `loaded`,
`installed` (plist/unit present, service not loaded), `not-installed`, or
`unsupported` (neither macOS launchd nor Linux systemd `--user`). The loaded
probe (`launchctl print` on macOS, `systemctl --user is-active` on Linux)
runs only when a plist/unit is actually installed, so the common
never-installed vault pays one `existsSync`. `not-installed` and
`unsupported` are **informational, not
attention** — one-shot `dome sync` and a foreground `dome serve` are valid
modes. `installed`-but-not-loaded routes the `service_not_loaded` attention
reason to `dome restart`: a KeepAlive agent that is not loaded means the
ambient compiler silently stopped.

**Model-provider reachability.** `model_provider_configured`,
`model_provider_probe_status`, and `model_provider_probed_at` report
last-known provider reachability. The tradeoff: the
`dome.model-provider.probe/v1` probe spawns the provider command with up to
an 8s timeout — far over status's cheap-pulse budget — so **plain `dome
status` never spawns the provider**. Instead it reads the persisted
last-probe cache at `.dome/state/model-provider-probe.json` (derived,
gitignored; written by `dome doctor` and by `dome status --probe`), and only
when the cached command matches the currently configured one — a provider
swap implicitly invalidates the cache, so stale attention never survives a
config change. A cached/live unreachable outcome (`spawn-failed` /
`invalid-response` / `timed-out`, the same classification as doctor's
`model.provider-unreachable` finding) adds the `model_provider_unreachable`
attention reason routed to `dome doctor --json`. When no cheap cached result
exists, the probe state reads null and routes nothing; `--probe` opts into
the fresh (slow) probe and refreshes the cache. The cost asymmetry is
deliberate: reachability attention is at most one probe stale by default,
which is the right trade for a command agents run at every session boundary. Generated AGENTS guidance tells
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

### `dome settle <block-id> <close|defer|keep> [--until <yyyy-mm-dd>] [--json]`

Settle an open task by its `^block-anchor` — the decision channel for tasks,
the sibling of `dome resolve` for questions ([[wiki/specs/task-lifecycle]]
§"The settle operation"). `<block-id>` is the task line's anchor id (visible
in `dome today` / `dome query` output as `^<id>`); `<disposition>` is one of
`close` (mark the line done and append a `Done today` bullet to today's
daily, in one commit), `defer` (rewrite the `📅` due token to `--until`), or
`keep` (settle without writing anything — no commit). This is a **thin CLI
binding**: all lookup, disposition, and commit semantics live in
`performSettle` (`src/surface/settle.ts`), the same collector the HTTP
`POST /settle` route and the MCP `settle` tool call — settle never opens the
runtime and never talks to the engine, exactly like `dome capture`.

`--until` is passed through untouched; `performSettle` owns validating it as
`YYYY-MM-DD` (required iff `<disposition>` is `defer`).

Text output is one line: `dome settle: <disposition> ^<block-id>` (plus the
short commit oid when one landed). `--json` emits `dome.settle/v1`:
`{ schema, status: "settled", block_id, disposition, commit }` (`commit` is
`null` for `keep` and for an idempotent no-op) or
`{ schema, status: "not-found" | "invalid", message }`.

Exit codes: `0` on `settled`; `64` (`EX_USAGE`) on `not-found` (no line
carries the anchor) or `invalid` (bad disposition, or `defer` without a
well-formed `--until`).

### `dome query <text> [--category <c>] [--type <t>] [--limit <n>] [--miss [note]] [--json]`

Invokes the `dome.search.query` view-phase processor against adopted-state
projections. The processor reads FTS rows and related facts through
`ctx.projection`; it does not read the working tree. Before dispatch, the
shared view-command boundary resolves the adopted commit and rebuilds
`projection.db` if the stored adopted commit, extension-set hash, or
processor-version hash is stale. Output (text mode):

```text
dome query - docs                                              √ 4 matches

  "platform ownership" — 4 matches

  MATCHES
    1  Platform Team Ownership      wiki/syntheses/platform-team-ownership.md
       › Decisions
       Atlas owns runtime; platform owns infrastructure boundaries...
       wiki/syntheses/platform-team-ownership.md:14-22 @ 41a98c2
       questions:
         • [#42] Possible follow-up in wiki/syntheses/...
           policy: owner-needed
           resolve: dome resolve 42 <track|ignore>

    2  2026-05-23                                   wiki/dailies/2026-05-23.md
       Discussed platform ownership with Danny...
       wiki/dailies/2026-05-23.md:48-52 @ 41a98c2
```

`--json` emits the structured `dome.search.query/v1` payload. Every match
carries SourceRefs because the search-document rows are written from
SearchDocumentEffect. FTS rows are heading-section granular (per
[[wiki/specs/projection-store]] §"fts_documents"); the processor collapses
section hits to the best section per page and each match carries that
section's `sectionId` and `breadcrumb` (`<page title> › <heading path>`) plus
section-ranged SourceRefs. Text mode prints the breadcrumb as an indented
`› <section name>` line (the page title prefix is stripped) when the best hit
is a non-intro section. The processor fetches an
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
The three candidate channels (FTS, projection recall, link expansion) are
disjoint by construction — a page already present as an FTS or recall
candidate is excluded from the expansion channel's candidate list, so no page
can render as a duplicate result row.
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
RRF fusion signals described above. Pages whose `dome.page.status` fact says
`superseded` (per [[wiki/specs/page-schema]] §"Supersession (ADR pattern)")
have their composite score multiplied by ×0.3 and carry an explainable
`superseded`-kind signal ("superseded by <forward target>") — downranked,
never filtered, so superseded pages stay findable for history questions. The
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

`--miss [note]` records this query as a retrieval-miss dogfood entry AFTER
the results above have printed — the mechanical channel for the "note the
miss" instruction the vault AGENTS.md template used to leave to hand-editing.
The bare flag (no value) defaults the entry's note to `no note`; a supplied
value becomes the note verbatim. This is a **thin CLI binding**: the append,
grammar, and commit all live in `reportMiss` (`src/surface/report-miss.ts`,
the same collector `dome export-context --miss` and the MCP `report_miss`
tool call) — `dome query` never opens the retrieval-miss file itself. It
appends one grammar-exact bullet to `meta/retrieval-misses.md` (created with
a header on first miss) — `- YYYY-MM-DD — "<query>" — <note>` — and lands it
as ONE ordinary human commit (`miss: <query first 40 chars>`, no `Dome-*`
trailers), exactly like `dome capture`/`dome settle`; never opens the runtime
and never talks to the engine. The acknowledgment (`dome query: miss
recorded (<short-oid>)` or `... miss not recorded: <reason>`) prints to
stderr so stdout stays exclusively the query's own output/JSON. This is the
mechanical channel the retrieval miss-log gate ([[memory]] §"M6 — Banked
embeddings design (spec-only)": "implementation proceeds when the log shows a
real miss rate") was missing — see [[wiki/specs/vault-layout]]
§"`meta/retrieval-misses.md`".

### `dome lint [--fail-on <severity>] [--limit <n>] [--json]`

Dedicated wrapper for the `dome.lint.report` view processor. It reads the
adopted-state diagnostic projection plus deterministic snapshot checks through
the normal view context; it does not scan the working tree and never mutates
state.

Default text output renders verdict-first with issues inline, no footer rule:

```text
dome lint - work                                                 ⚠ 3 issues

  ! dome.markdown.broken-wikilink - wiki/projects/platform.md
      Broken wikilink: [[missing]]

  ! dome.markdown.missing-frontmatter - wiki/projects/platform.md
      Markdown file has no YAML frontmatter block.

  ! dome.markdown.missing-frontmatter - wiki/notes/scratch.md
      Markdown file has no YAML frontmatter block.
```

`--verbose` adds a `CHECKED` section (files, fail-on, issue counts) before the
findings. When no issues exist, the default output collapses to one line:

```text
dome lint - work                                    √ pass — 1,247 files, no issues
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
breadcrumb as a `- Section: <page title> › <heading path>` line), one-hop
`dome.graph.links_to` expansion
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
`- Relevance:` lines, and the overview's `Recall Signals` section expose the
source-backed signals that promoted an entry. Entries are also
bounded by `--limit`; the structured JSON includes `shown.entries`,
`hasMore.entries`, `overview`, per-entry `ranking`, and text mode prints an
expansion hint when more adopted-state matches are detected. `--json` emits the
structured `dome.search.export-context/v1` payload, including the packet under
`markdown`; `entries[].summary` carries the source-backed compact summaries, and
`overview.recallSignals` carries the same source-backed recall evidence for
structured consumers.

### `dome today [--date <yyyy-mm-dd>] [--limit <n>] [--watch] [--interval <seconds>] [--json] [--verbose]`

The terminal cockpit — a typed dedicated wrapper over the command-triggered
`today` view (`dome.daily.today`, structured schema `dome.daily.today/v1`),
exactly the `dome query` posture: the `dome.daily.today` processor owns the
action surface (see §"Daily view processors — shared substrate" for the
underlying view's normative behavior); this verb owns CLI ergonomics and
rendering. It
routes through the same shared view-command boundary and validates the same
one-view/effect-name/schema contract as the other dedicated wrappers.

Default text output uses the **Briefing v2 presenter** (CB-T4): a `dome
today` headline with the vault basename and a right-aligned verdict
(`√ all clear` or `x <n> overdue · <m> open`). The default body shows the
brief when present, today's agenda when present, and open tasks/followups in
urgency buckets (`OVERDUE`, `TODAY`, `THIS WEEK`, `LATER`, `SOMEDAY`) with
compact task rows. Task rows stay terse by default. `--verbose` uncaps bucket
lists and adds a muted `why:` line under each task with due/overdue reason,
source-backed vs. daily-local scope, carry-forward projection provenance,
attention discount metadata, and any task origin marker. `dome decide` is not
emitted.

- `--date <yyyy-mm-dd>` and `--limit <n>` pass through to the view's
  `date` / `limit` command args (same semantics as `dome run today`).
- `--json` emits the structured `dome.daily.today/v1` payload unchanged.
- `--verbose` uncaps the human task lists and prints compact per-task
  provenance; it does not mutate or clean up the daily note.
- `--watch` is the cockpit mode: re-render on an interval until ctrl-c
  (SIGINT/SIGTERM). It is **poll-based re-render** — dumb polling per the v1
  plan's open-questions resolution, not a push channel. Each iteration
  re-runs the view; the screen is repainted **only when the rendered text
  changed** (the clear-screen escape is TTY-gated, so piped watch output
  stays clean), with a muted `(watch: refreshes every <n>s — ctrl-c to
  exit)` footer. A render error exits the loop with that error's exit code.
  The interval sleep is abortable, so ctrl-c exits immediately instead of
  parking up to a full interval.
- `--interval <seconds>` sets the watch cadence (default 5, floor 1).
- `--watch` and `--json` are mutually exclusive (exit 64): watch is a
  repainting human surface, and agents polling for structured state should
  loop `dome today --json` themselves.

Testability matches the other wrappers: the watch loop accepts injected
sleep/clear/render/iteration boundaries, pinned by
`tests/cli/commands/today.test.ts` (render shape, watch repaint-on-change,
clear gating, sleep cadence, flag exclusivity).

Exit codes: 0 on success; 64 (EX_USAGE) on `--watch` + `--json`, a missing
`today` view processor, or an unusable adopted ref; 1 on runtime or dispatch
failure.

### `dome log [--since <date>] [--processor <id>] [--grep <text>] [--limit <n>] [--json]`

The vault's activity view — newest-first git history joined with the run
ledger. Per [[wiki/invariants/NO_ACCRETING_REGISTRIES]] the activity log is
not a file agents append to (`log.md` is frozen); it is a render over the two
surfaces that already record everything: git commits (engine commits carry
the `Dome-*` trailers per [[wiki/specs/adoption]] §"Engine commit trailers",
and their bodies carry the PatchEffect's narrative `reason`) and `runs.db`
(the `Dome-Run` trailer equals `runs.id` — the dual-surface join key per
[[wiki/specs/run-ledger]]).

**CLI-native posture** (the `dome status` stance): read-only, no runtime
lock, no Proposal, no view-command boundary. The collector is
`buildActivityLog` in `src/surface/activity.ts` (shared surface — MCP/HTTP
adapters can adopt it later); git spawning stays inside `src/git.ts`. A vault
whose `runs.db` does not exist yet (or fails to open) still renders — engine
entries simply carry `run: null`; the CLI never scaffolds state in a vault it
only reads.

Each entry carries the commit SHA, ISO timestamp, an `engine`/`human` author
discriminator (engine iff a non-empty `Dome-Run` trailer is present), the
subject, the body with the `Dome-*` trailer block stripped, and — when the
ledger join lands — the run's status, duration, and cost. Text mode renders
one block per entry: a `<relative-time> · <author> · <subject>` headline
(relative time such as `2h ago`, `just now`; ISO timestamp available via
`--json`), the commit body sans Dome trailers in muted text, and — for engine
entries — a muted `run <id> <status> · 3.2s · $0.04` line.

- `--since <date>` — lower time bound; anything `git log --since` accepts.
- `--processor <id>` — keep engine entries only, matched against the joined
  run row's processor id, the `Dome-Extension` trailer, or the commit
  subject (engine(applyPatch) subjects carry the processor id verbatim).
- `--grep <text>` — case-insensitive substring filter over subject + body.
- `--limit <n>` — maximum entries (default 30). Maps to git's `-n` only when
  no post-filter runs; a filtered read walks the (since-bounded) history so
  filters see past the first `limit` commits. Deliberate scope cut: no
  pagination beyond this.
- `--json` — emit the structured `dome.log/v1` payload (`{ schema,
  entries }`).

Tests: `tests/cli/commands/log.test.ts` and `tests/surface/activity.test.ts`.

Exit codes: 0 on a clean read (including an empty history); 1 when the vault
has no git history surface (not a repo) or the activity read fails.

### `dome recipe <kind> [--url <base>]`

Prints a setup recipe — plain text on stdout, by design: recipes change when
the surfaces they describe change, so they ship next to the CLI instead of in
docs that can drift. It never opens the vault or the runtime.

`<kind>` selects the recipe. v1 ships three:

**`ios`** — the iOS Shortcut that voice-captures into `POST /capture` (the
WS3-capture deliverable; see [[wiki/specs/capture]] §"Phone and voice ingress
(recipe)"). The printed text covers the prerequisites (a running `dome http`
bound to a Tailscale-class interface; the phone on the same network; a
`DomeCaptures` folder in iCloud Drive for the queue fallback) and the
Shortcut build steps: Dictate Text, then a `<timestamp>-<uuid>` capture id
shared by the POST body's `captureId` and the queue filename (so both
channels dedupe to one capture), then **Save File into `DomeCaptures/`
before the POST** — queue-first, because Shortcuts has no try/catch and an
unreachable host simply stops the Shortcut, so the pre-saved file is the only
failure branch ([[wiki/specs/capture]] §"The iCloud queue fallback") — then
Get Contents of URL with the bearer header, then Delete Files on success.
Plus a copyable `curl` verification command and the `GET /today?token=…`
cockpit URL. The queue this Shortcut leaves behind is drained by its sibling
recipe, `dome recipe capture-queue`; once captures flow, the brief they feed
is only as personal as `core.md` — seed it with `dome recipe core-seed`.

**`capture-queue`** — the laptop half of the queue fallback whose phone half
is the `ios` recipe's Shortcut: the printed text
installs the shipped drain script (`assets/source-handlers/drain-captures.sh`,
copied to `<vault>/.dome/bin/`; the recipe interpolates the real shipped
path) and a launchd LaunchAgent (`com.dome.drain-captures`, `StartInterval`
900 + `RunAtLoad`, `WorkingDirectory` = the vault root so `dome capture`
resolves the vault), covers the two possible queue locations (the iCloud
Drive root vs. the Shortcuts container), and ends with a smoke test. Drain
semantics — one `dome capture --file <f> --capture-id <stem>` per queue
file; exit 0 (captured *or* duplicate) deletes the file, non-zero keeps it
for the next interval; `.icloud` placeholders get a best-effort
`brctl download` — are normative at [[wiki/specs/capture]] §"The iCloud
queue fallback". Deliberately a recipe-installed external job (the manual
`dome-http` unit precedent), not a `dome.sources` subscription — the why is
recorded at [[wiki/specs/sources]] §"What is deliberately NOT a
subscription: the capture-queue drain".

**`core-seed`** — the owner interview that seeds `core.md`, the always-loaded
core memory page ([[wiki/specs/vault-layout]] §"`core.md`"). The printed text
explains the page's three sections (`## Who I am` and
`## Standing preferences` are owner-authored; `## Active projects` is
generated by `dome.agent.active-projects` and never hand-authored) and
carries a paste-ready interview prompt for a foreground session (Claude Code
or any agent harness): four questions asked one at a time, then a draft of
ONLY the two owner-authored sections for the owner's edit and approval. The
prompt's standing rules ride along — keep the page under the 6,000-character
size budget, never write inside marker-delimited generated blocks, leave the
`## Active projects` heading empty. The natural install order runs `ios` →
`capture-queue` → `core-seed`: capture ingress first, then the queue drain
behind it, then the core memory the resulting briefs draw on.

- `--url <base>` overrides the base URL baked into the printed `ios` recipe
  (default `http://<your-server>:3663`; trailing slashes are stripped). The
  value must parse as an http(s) URL — anything else (a bare `host:port`
  typo, a non-http scheme) is a usage error: stderr carries the corrective
  message, nothing is printed to stdout, and the command exits 64.
- An unknown `<kind>` is a usage error: stderr names the available recipes
  and the command exits 64.

Tests: `tests/cli/commands/recipe.test.ts`.

Exit codes: 0 on success; 64 (EX_USAGE) on an unknown recipe kind or a
`--url` that is not an http(s) URL.

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

### Daily view processors — shared substrate

`dome today`, `dome prep`, and `dome agenda-with` are three dedicated
top-level verbs over the same source-backed daily action state — this
section is the normative behavior shared across all three; each command's
own `###` section above/below owns only its CLI-specific ergonomics
(rendering, flags). `dome run today` additionally exercises the raw
`dome.daily.today` view for deterministic debugging (always-JSON, no
presenter); `dome prep` and `dome agenda-with` are themselves the dedicated
verbs — there is no separate "run-only" flavor of those two left.

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
`dome.daily.today` view processor for deterministic debugging. The dedicated
cockpit wrapper over the same view is `dome today` (§"`dome today`"), which
adds presenter rendering and `--watch`; the primary V1 workflow remains the
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
their backing source item is still live, then fills initial empty slots from the
freshly ranked candidate set. Same-day settled rows (`Resolved Today` /
`Dismissed Today`) count against that day's surface cap, so checking items off
contracts today's work queue instead of pulling new backlog into the vacated
slots. This gives the daily cockpit stable same-day ordering without letting
completed or deleted source items linger. When the same loop also exists as an
original project, meeting, capture, or prior-daily fact,
the view folds the rows together, counts the representative as `daily`, and keeps
representative source refs for the daily surface plus the backing source.
Rendered daily/prep/agenda rows use the compact `evidenceLabel` from that folded
evidence: a generated daily row can display `daily.md:24; source project.md:8`
instead of hiding the backing source behind a separate SourceRefs section.

Settling a generated source-backed item is still meaningful markdown evidence.
On the next carry-forward pass, Dome keeps `[x]` rows under
`### Resolved Today` and `[-]` rows under `### Dismissed Today` in that daily
note. Both states suppress the same carried `^anchor` identity (falling back to
source/body identity for legacy unanchored rows) and equivalent repeated surface
loops from future daily surfaces. This lets the daily note act as a collaborative
work queue without storing hidden dismissal state in `.dome/state`; the
companion `dome.daily.reconcile-tasks` pass propagates the settled marker back
to the origin line.

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
`dueDate`, `priority`, `lastChangedAt`, `evidenceLabel`, `attention`, and the
folded row's complete `sourceRefs`. `shown` and `omitted` mirror the bounded arrays so
agents do not need to infer truncation from array lengths. `--date` is for
reviewing another day and for deterministic tests; omitted means local today.

`dome prep [--date <YYYY-MM-DD>] [--limit <n>] [--json]` wraps the
`dome.daily.prep` view processor. It uses the same source-backed daily action
state as `dome today`, then renders a portable planning packet for the
target day. It is a deterministic filter over that state, not a substitute
for natural-language planning/meeting-prep requests — `query` /
`export-context` remain preferred when the request isn't already shaped as
"today's plan for a specific day."

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

The shared daily action model is the same as `dome today`: each
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
to `<limit>` backlog rows" rule as `dome today`. Detailed sections do not
repeat rows already shown in "Start Here"; they render an "already listed"
count and then show the remaining bounded rows by source group. The markdown
packet's SourceRefs section is bounded by the rendered planning/action scope.
`--json` emits the structured `dome.daily.prep/v1` payload, including
`dueCounts`, `shown` / `omitted` counts for the bounded start list and action
sections, task-derived `dueDate` / `priority` / `lastChangedAt` metadata,
compact `evidenceLabel` values, plus the markdown packet under `markdown`.
`--date` is for prepping a chosen day and for deterministic tests; omitted
means local today.

`dome agenda-with <person-or-topic> [--date <YYYY-MM-DD>] [--limit <n>]
[--json]` wraps the `dome.daily.agenda-with` view processor. It reuses the
same source-backed daily action state as `dome today` / `dome prep`,
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

### `dome stale-claims [--json]`

Wraps the `dome.claims.stale-claims` view processor: lists every claim whose
inline `*(as of YYYY-MM-DD)*` marker is older than the configured horizon
(`stale_claims_horizon_days` config key, default 120), computed at command
time against the injected clock — never persisted, since staleness is
relative to "now" and a rebuild at a later date must not mint different rows
from identical adopted markdown (see [[wiki/specs/claims]]
§"`dome.claims.stale-claims`"). Default text output lists each stale claim's
page, key/value, `asOf` date, and days-stale count; `--json` emits the
structured `dome.claims.stale-claims/v1` payload (`horizonDays` plus the full
`staleClaims` array). Exit code is always 0 — staleness is a report, not a
failure condition.

### `dome orphan-pages [--json]`

Wraps the `dome.markdown.orphan-pages` view processor: lists every markdown
page with zero incoming wikilinks that is not itself a root `index.md` and
not implicitly linked from one (a root's `index.md` is treated as linking to
every other file under that root even without an explicit `[[wikilink]]`).
Reads `dome.graph.links_to` facts from the projection plus the adopted
snapshot's full markdown file list. Default text output lists each orphan
page's path; `--json` emits the structured `dome.markdown.orphan-pages/v1`
payload (`totalScanned`, `totalOrphans`, and the full `orphans` array). Exit
code is always 0.

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

### `dome reanchor [--to <sha>] [--vault <path>] [--bundles-root <path>] [--json]`

The explicit adopted-ref **divergence recovery** verb — the one user-facing
path that moves `refs/dome/adopted/<branch>` without a fast-forward. It
exists for exactly one state: the branch history was rewritten under the
adopted cursor (force-push, hard-reset, rebase — see
[[wiki/gotchas/adopted-ref-divergence]]) and the operator has confirmed the
new HEAD is the intended trunk. The engine's own write side stays
fast-forward-only per [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]];
`dome serve` pauses adoption and `dome sync` refuses while diverged, and the
`adopted-ref.diverged` health finding (doctor/check/status attention) names
this command in its recovery text.

Composition (v1.0):

1. Resolve `vaultPath`, branch, HEAD, and the adopted ref. Detached HEAD, no
   commits, and an uninitialized adopted ref are usage refusals (exit 64) —
   there is no cursor to recover.
2. **Refuse when not diverged** (exit 64). When the adopted ref equals HEAD
   or is an ancestor of HEAD, the normal fast-forward path (`dome sync`) is
   the only legitimate advance; reanchor must never become a casual
   force-move habit.
3. Resolve the target: `--to <sha>` (a full commit OID) or the current HEAD
   by default. The target must be HEAD or an ancestor of HEAD — anything
   else would immediately re-create the divergence (exit 64).
4. Open the runtime *before* mutating any ref, so a misconfigured vault
   refuses without a half-done recovery (exit 1 on open failure).
5. **Back up first, then move.** Write
   `refs/dome/backup/adopted-<timestamp>` (ref-safe UTC `YYYYMMDDTHHMMSSZ`;
   same-second collisions get a `-2`, `-3`, … suffix) at the old adopted
   SHA, then advance the adopted ref to the target via the internal
   `forceAdvance` opt-out. The backup keeps the orphaned engine/human
   commits reachable (no GC) and makes the move reversible; the old SHA is
   also recorded in the command output.
6. **Trigger the normal sync path**: one compiler-host tick against the
   re-anchored cursor. A target of HEAD lands `in-sync` (operational drain);
   an ancestor target adopts the remaining range immediately. Subsequent
   `dome serve` polls resume normal adoption.

The ref move itself is compare-and-swap (`setAdoptedRef` writes with the
expected old value), so a concurrent host advancing the ref cannot be
silently overwritten; the follow-up tick takes the same branch-level
compiler-host lock as every other host.

`--json` emits `dome.reanchor/v1`: `{ schema, status: "reanchored" |
"error", vault, branch, head, previous_adopted, new_adopted, backup_ref,
sync: { kind, final_adopted }, error?, message? }`.

Exit codes: 0 on success; 64 (EX_USAGE) on detached HEAD, no commits,
uninitialized adopted ref, **not diverged**, or a `--to` target not reachable
from HEAD; 1 on runtime-open or ref-write failure.

### `dome inspect <subject> [--limit <n>] [--days <n>] [--model] [--json]`

Read-only view over the operational substrate. The command opens the
runtime (so the operational databases are initialized) but does not submit a
Proposal, does not invoke any processor, and does not mutate state. The one
exception to the runtime open is the `cost` subject, which is ledger-only —
see its entry below.

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
- `cost` — per-processor model spend aggregated from `runs.db`'s `cost_usd`
  over a `--days <n>` window (default 7): cost-bearing run count, window
  total, and today's spend per processor, plus extension subtotals (grouped
  by the processor id's parent namespace) and a grand total. The today split
  uses the same local-midnight boundary as the `maxDailyCostUsd` budget
  scopes ([[wiki/specs/run-ledger]] §"Cost tracking"), so the report and the
  caps agree on what "today" means. Unlike the other subjects, `cost` does
  not open the vault runtime: it opens the run ledger **read-only** and
  mirrors `dome log`'s refuse-to-scaffold posture — a vault without
  `runs.db` gets a clean zero table, never a freshly created database file.
  `--json` emits a `dome.inspect.cost/v1` envelope (`schema`, `days`,
  `since`, `today`, `processors`, `extensions`, `total`) rather than bare
  rows. `--days` is a cost-only flag, so `dome inspect runs --days 7` is a
  usage error.

`--limit <n>` caps the row count. Operational row subjects default to 20;
`bundles`, `processors`, and `cost` default to the full set because they
are bounded (extension metadata, or one row per cost-bearing processor)
rather than unbounded operational history. A `--limit` on `cost` truncates
the processor table without changing the subtotals or the grand total — a
sliced table must not understate spend. `--model` is valid for `bundles` and `processors`: on `bundles` it
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
answer that also covers configured-but-disabled optional bundles.

Exit codes: 0 on a clean read (including empty result sets); 1 on
runtime-open failure (or, for `cost`, a present-but-unopenable ledger); 64
(EX_USAGE) on unknown subject or malformed `--limit` / `--days`.

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

Future subjects (v1.x): `orphan-runs`, `recent-activity`,
`recent-processor-divergence`. Adding a subject is one new query
function + one case in the dispatcher; no new CLI surface per subject.

### `dome doctor [--json] [--repair]`

Engine-substrate **health check** verb. The current implementation is
probe-only and read-only: it reports failed/stuck outbox rows, orphan running
rows, quarantined processor triggers, projection cache drift, adopted-ref
divergence, instruction drift, operational schema mismatches, and enabled
processor capability kinds that are declared but not granted. For granted
kinds it additionally evaluates the **manifest-contributed grant-entry
probes** (`doctor.grantEntries:` per [[wiki/matrices/extension-bundle-shape]]
— each bundle declares its own; the runtime composes active bundles'
entries): when an enabled processor's manifest declares a specific path or
fact namespace that the vault's grant patterns miss (e.g. `dome.agent`
without `"core.md"` read, the preference-promotion answer handler without
its per-processor replacement grant), doctor raises a
`capability.grant-entry-missing` warning whose
recovery text names the exact YAML to add — `dome init --refresh-config`
fills only missing keys and never merges entries into existing grant lists,
so these gaps are otherwise silent (see `docs/memory.md` §"Vault rollout").
Beyond the hand-curated rows, the **general grant-starvation probe**
(`capability.grant-starved`, **info**) covers every loaded processor: for
each manifest-declared `read` / `patch.auto` pattern it derives a
representative concrete path (glob segments replaced with literals,
sanity-checked against the broker's own matcher) and reports the patterns
whose representative the effective grant — per-processor replacement grants
included — does not cover. Info severity because narrowed grants can be
deliberate; two suppressions keep it honest: a pattern a hand-curated
`doctor.grantEntries` row already watches is skipped (hand rows keep their
curated messaging), and a grant that deliberately narrows WITHIN a declared
pattern (some granted pattern's representative falls inside it, e.g.
`wiki/entities/**/*.md` under declared `wiki/**/*.md`) is treated as a
choice, not starvation — only a declared pattern with zero grant
intersection (the silently-ungranted calendar-weave failure mode) is
reported.
It also reports
enabled/granted model-capable processors when the vault has no configured or
host-injected model provider, and — when both `dome.daily` and `dome.agent`
are enabled — a `config.daily-path-mismatch` warning when the two bundles'
`daily_path` config keys diverge (the morning brief and create-daily would
target different files; see [[wiki/specs/autonomous-agents]] §"`dome.agent.brief`").
When any `dome.sources` subscription is enabled while
`engine.external_handler_timeout_ms` is unset, doctor raises a
`config.sources-timeout-default` **info** finding suggesting `300000` for
model-backed fetch commands (the timeout footgun;
[[wiki/specs/sources]] §"Timeout").
When an enabled `dome.sources` subscription's fetch command references a
script file that is missing or not a regular file, doctor raises a
`sources.fetch-script-missing` **warning** naming the kind and path, with
`dome init --with-source <kind>` in the recovery text — the
stanza-enabled-but-never-scaffolded gap, caught before every scheduled fetch
fails overnight. The probe is **static**: doctor never executes the fetch
command; the script reference is derived from the command shape alone
(`command[0]` when it carries a path separator, else `command[1]` under a
bare interpreter name, skipping flag arguments), and commands with no
checkable reference — bare PATH lookups, `sh -c` inline scripts — are
silently unprobed rather than false-positived; their failures still surface
through the outbox findings ([[wiki/specs/sources]] §"The flow").
When the vault's **effective** `git config commit.gpgsign` resolves true
(probed at the doctor boundary by spawning native git, so local/global/
system scopes resolve exactly as a shelled `git commit` would see them —
the inherited-global case is the day-one hazard), doctor raises a
`git.commit-signing` **info** finding. Purely informational: Dome's own
commit paths are immune (engine adoption commits and `dome capture` use
isomorphic-git, which never invokes gpg; the shipped dome.sources fetch
templates commit with `git -c commit.gpgsign=false` —
[[wiki/specs/sources]] §"The handler contract"), and the finding names the
still-affected paths (the owner's own `git commit`, custom vault-side
scripts shelling plain `git commit`) with `git config --local
commit.gpgsign false` as the opt-out if the owner wants unsigned human
commits too — their call.
When `runs.db` exceeds 512 MB on disk, doctor raises a `ledger.oversized`
**warning** finding naming the file size, the threshold, and the count of
retained failure-forensics rows. The run ledger works fine at any size; the
finding is a nudge toward setting `ledger.retention_days` in
`.dome/config.yaml` (the `dome init` template opts in at 30 days; `dome
serve` applies it daily — see [[wiki/specs/run-ledger]] §"Retention") or
running a one-off
`dome repair run-ledger --older-than-days <n> --apply --vacuum`. Both
remedies share the eligibility predicate that never deletes failure
forensics (`failed` / `timed_out` / `cancelled` / reason-bearing `skipped`),
so the recovery text also names the case where pruning doesn't shrink the
file: a failure-dominated ledger is fixed by fixing the failing processor,
not by tightening the retention window.
The implementation lives in `src/engine/host/health/` (one file per probe
concern; `registry.ts` is the ordered probe list).

**Model-provider probe.** When `.dome/config.yaml` carries a
`model_provider: { kind: "command", ... }` stanza, `dome doctor` additionally
probes the provider command by spawning it from the vault root and writing a
`dome.model-provider.probe/v1` envelope on stdin (see [[wiki/specs/capabilities]]
§"model.invoke" for the envelope contract; the probe is cheap by construction —
a conforming provider answers without any network or paid API call). The prober
(`probeCommandModelProvider` in `src/engine/host/command-model-provider.ts`)
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

The probe runs only in `dome doctor` (the probe verb) and the opt-in
`dome status --probe`; `dome check` reuses the same `HealthReport` machinery
but does not spawn the provider. Doctor persists each probe outcome to
`.dome/state/model-provider-probe.json` (derived, gitignored — the same
class as the serve heartbeat) so `dome status` can report last-known
reachability for the cost of one JSON read; see §"`dome status`"
"Model-provider reachability" for the cache-matching rule. Together with
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
- **Explicit guarded repairs** → `dome repair <subject>` for narrow,
  operator-initiated repairs that are not question answers. The command
  defaults to dry-run. Current subjects are `task-anchors` (remove duplicate
  `^t...` identities from non-first task-origin lines so `dome sync` can
  restamp them) and `run-ledger` (prune old low-signal terminal rows with
  `--older-than-days N --apply`, preserving failures and active rows).
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

### `dome repair <subject> [--dry-run] [--apply] [--json]` *(hidden advanced repair)*

Explicit guarded mutation surface for narrow repairs. `--dry-run` is the
default, `--apply` is required to write, and `--apply --dry-run` is a usage
error.

`task-anchors` scans markdown task-origin lines for duplicate `^t...` task
anchors. The dry-run report lists the non-first occurrences whose anchor would
be removed; `--apply` removes only those duplicated anchors and leaves the next
`dome sync` to stamp fresh stable identities.

`run-ledger` requires `--older-than-days <n>`. It prunes only old `succeeded`
rows and idempotency-style `skipped` rows with no error, first deleting their
`capability_uses` children inside the ledger layer. It preserves failed,
timed-out, cancelled, queued, running, and reason-bearing skipped rows.
`--vacuum` is valid only with `--apply` and runs SQLite `VACUUM` after the
delete. This is the manual, ad-hoc-window sibling of the automatic
`ledger.retention_days` policy `dome serve` applies daily when the key is set
(the init template opts in at 30 days — [[wiki/specs/run-ledger]]
§"Retention"); both
share the same eligibility predicate in `src/ledger/runs.ts`, so reach for
this command only when an immediate prune or a one-off window different from
the configured default is wanted.

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

1. `openVaultRuntime({vaultPath, bundlesRoot, additionalBundlesRoots})` opens the operational databases (`projection.db`, `answers.db`, `outbox.db`, `runs.db`) and loads extension bundles from the resolved root set (SDK-shipped `assets/extensions/` by default, plus vault-local `.dome/extensions/` when present; `--bundles-root` replaces the set). Two host-open findings are logged loudly right after open, regardless of `--quiet`: a pruned-quarantine line (a quarantine row for a processor id no active bundle registers, per the registry-orphan GC) and, when `dome.agent` is enabled with no model provider configured or injected, the one-line `agent.no-model-provider` warning ("dome.agent is enabled but no model provider is configured; run `dome init --with-model-provider` or set enabled: false") — the runtime complement to `dome doctor`'s `model.provider-missing` config-time probe (product-review-3 Task 17).
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
8. The host also runs operational-work pumps while HEAD is already in sync, on a quiet internal cadence. This is how schedule triggers, opt-in low-risk question auto-resolution, and outbox retries that become due solely because time passed make progress in a quiet vault. Default output stays silent; `--verbose` may print counts.
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
startup failures, detached-HEAD pauses, blocked adoption diagnostics,
unexpected tick errors, and the two host-open findings named in step 1 above
(pruned quarantine state, `agent.no-model-provider`) — a starved or
recovering bundle is never silent, `--quiet` or not. `--quiet` and
`--verbose` are mutually exclusive.

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

Makes the local compiler host **ambient**: installs `dome serve` for the
vault under the platform's user service manager, keeps it alive across
crashes, and starts it immediately. This is the Phase 1 wedge enabler
([[wedge]] §"Phase 1 — Ambient daemon"): scheduled garden processors fire
without a human keeping a terminal or tmux pane open.

The backend dispatches on platform:

| Platform | Backend | Service identity |
|---|---|---|
| `darwin` | launchd LaunchAgent | `com.dome.serve.<slug>` plist in `~/Library/LaunchAgents/` |
| `linux` | systemd `--user` unit | `dome-serve-<slug>.service` under `~/.config/systemd/user/` |
| anything else | refused, exit 1 | "service install is supported on macOS (launchd) and Linux (systemd --user); run `dome serve` under your own service manager elsewhere" |

`<slug>` is shared by both backends: the lowercased vault basename with
non-`[a-z0-9-]` runs collapsed to `-`, plus the first 8 hex chars of the
SHA-256 of the resolved vault path. The same vault path always yields the
same label/unit; distinct vaults never collide, so one machine can run one
ambient host per vault.

Composition (macOS launchd):

1. Resolve `vaultPath` (default cwd) and the deterministic service label
   `com.dome.serve.<slug>` (shared slug rule above).
2. On unsupported platforms, refuse with exit 1 (message above). No plist or
   unit is written and no service manager is touched.
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

**Linux backend (systemd `--user`).** The same verbs, dispatched to the
systemd user manager (`systemctl --user`), mirroring the launchd contract
behind the same injected `ServiceDeps` boundary:

1. The same vault preconditions and `--env` / `--env-file` resolution apply
   (exit 64 on violations). One extra constraint is Linux-specific: systemd
   `Environment=` values are single-line, so an environment value containing
   a newline is a usage error (exit 64) instead of a corrupted unit file.
2. Install writes the unit to `~/.config/systemd/user/dome-serve-<slug>.service`
   (`$XDG_CONFIG_HOME/systemd/user` when set), then runs
   `systemctl --user daemon-reload` → `enable <unit>` → `restart <unit>`.
   Re-runs rewrite the unit and replace the running service, exactly like the
   plist path; a failed systemctl step leaves the unit on disk for
   inspection, prints the failing command's stderr, and exits 1.
3. The rendered unit mirrors the plist: `ExecStart` is the installing bun
   runtime + the SDK's dome entry + `serve --vault <vaultPath>` (quoted, with
   systemd `%` / `$` / quote escaping), `WorkingDirectory` is the vault,
   `Environment=` carries the same PATH-first entries plus `--env` /
   `--env-file` values, `Restart=always` + `RestartSec=2` mirror KeepAlive,
   stdout/stderr append to `<vault>/.dome/state/serve.log`, and
   `WantedBy=default.target` enables it for the user session.
4. Uninstall runs an **unconditional** `systemctl --user disable --now <unit>`
   — even when the unit file is absent, covering the
   deleted-unit-but-still-running edge (its failure just means nothing was
   loaded) — then removes the unit file and runs `daemon-reload`. Idempotent:
   a never-installed vault reports "not installed" and exits 0.
5. Restart runs `systemctl --user restart <unit>` **from the existing unit on
   disk** — never re-rendered, same `--env`-preservation rationale as the
   plist path. When no unit is installed for the vault, exit 64 with a
   pointer to `dome install`.
6. `--status` reports the unit name, unit path, `installed` (unit file
   present), and `active` (`systemctl --user is-active`, probed only when
   installed). JSON payloads carry the unit path under both `unit` and
   `plist` — the latter is the established `ServiceState` field name that
   `dome status` and the MCP status tool already consume.

One ops step is deliberately **not** automated: the user manager only runs
while the user has a session, so surviving logout/boot requires
`loginctl enable-linger <user>` — the operator's responsibility (it needs
root on some distros). The install success output prints this note, and the
server migration runbook
([[cohesive/runbooks/2026-06-server-migration]]) carries it as a prepare
step.

Tests: `tests/cli/install-systemd.test.ts` pins the unit rendering
(escaping included), the install/uninstall/restart systemctl sequences, the
unconditional-disable uninstall, and the exit codes against a recording fake
`systemctl` — never a real service manager.

`--status` is the read-only service probe: it reports the label, plist path,
`installed` (plist present in the LaunchAgents dir), and `loaded` (whether
`launchctl print gui/<uid>/<label>` resolves) without mutating anything. A
loaded service also writes the normal serve heartbeat, so `dome status`
shows `serve running` / `stale` while the agent is alive, and `dome status`
also carries the service line directly (`service_status` /
`service_label`, via the shared `probeServiceState` helper): installed-but-
not-loaded routes the `service_not_loaded` attention reason to
`dome restart`. `dome install --status` remains the row-level probe (it
also checks `loaded` for the deleted-plist-but-loaded edge, which the
cheap status line skips).

`--json` emits `dome.install/v1`: `{ schema, status:
"installed" | "status" | "error", vault, label, plist, log?, installed?,
loaded?, error? }`.

Concurrency: the launchd-managed host acquires the same branch-level
compiler-host lock as every other host, so an installed service plus a
foreground `dome serve` or one-shot `dome sync` do not race — one reports
busy and retries.

Testability is part of the contract: `runInstall` / `runUninstall` accept an
injected deps object (`platform`, `uid`, `launchAgentsDir`, a `launchctl`
runner, plus the Linux counterparts `systemdUserDir` and a `systemctl`
runner, and the bun/dome executable paths) defaulting to the real home
directory and real `Bun.spawn` runners. Tests pass a temp service dir and a
recording fake runner; they never touch `~/Library` / `~/.config/systemd` or
invoke a real service manager.

Exit codes: 0 on success (including idempotent re-install and clean
`--status` reads); 64 (EX_USAGE) on an uninitialized vault (missing git repo
or `.dome/config.yaml`), a malformed `--env`/`--env-file` entry, or a
newline-bearing environment value on Linux; 1 on an unsupported platform,
undeterminable uid (macOS), `launchctl bootstrap` / `systemctl` failure, or
unexpected I/O failure.

### `dome uninstall [--vault <path>] [--json]`

Removes the vault's ambient service. On macOS: `launchctl bootout
gui/<uid>/<label>` (failure ignored when the service is not loaded), then
deletes the plist from `~/Library/LaunchAgents/`. On Linux: an
**unconditional** `systemctl --user disable --now <unit>` — run even when the
unit file is absent, covering the deleted-unit-but-still-running edge — then
the unit file is removed and `daemon-reload` runs (see §"`dome install`"
"Linux backend"). Idempotent on both platforms — when no plist/unit is
present it still attempts the stop, reports "not installed", and exits 0. The
serve log at `.dome/state/serve.log` is preserved; it is operator evidence,
not service state.

Unsupported platforms get the same refusal as `dome install` (exit 1).

`--json` emits `dome.uninstall/v1`: `{ schema, status:
"uninstalled" | "not-installed" | "error", vault, label, plist, error? }`;
on Linux the payload additionally carries the unit path as `unit` (with
`plist` mirroring it for established consumers).

Exit codes: 0 on success or already-not-installed; 1 on an unsupported
platform, undeterminable uid (macOS), or unexpected I/O failure.

### `dome restart [--vault <path>] [--json]`

Restarts the vault's ambient service from the service definition already on
disk. On macOS (launchd): `launchctl bootout gui/<uid>/<label>` (failure
ignored when the service is not loaded — a dead
service is exactly why an operator restarts), a **drain wait** (poll
`launchctl print gui/<uid>/<label>` until the label leaves launchd, bounded
at 15 s — `bootout` returns before a serve mid-agent-run actually exits, and
bootstrapping during the drain fails with `Bootstrap failed: 5`), then
`launchctl bootstrap gui/<uid> <plist>` **from the existing plist on disk**.
`dome install` re-runs share the same drain wait between their bootout and
bootstrap. On drain timeout the bootstrap proceeds and its error surfaces
honestly.

On Linux (systemd `--user`): `systemctl --user restart <unit>` against the
existing unit file — systemd owns the stop/start sequencing, so no
launchd-style drain wait is needed. When no unit file is installed for the
vault, exit 64 (EX_USAGE) with a pointer to `dome install`; a failed
`restart` prints systemctl's stderr and exits 1.

The plist/unit is deliberately **not re-rendered**. The service's
environment entries (`--env` / `--env-file` credentials such as
`ANTHROPIC_API_KEY`) are remembered only inside the plist/unit itself —
re-rendering from scratch would silently drop them, which is the failure
mode `dome install` re-runs already carry ("env entries are not remembered
across re-installs"). Restart is therefore the safe "bounce the daemon"
verb after a config edit, a wedged host, or an environment change applied
via `launchctl setenv`; `dome install` remains the only path that rewrites
the plist or unit.

Refusals are clean and mutate nothing: when no plist/unit is installed for
the vault, exit 64 (EX_USAGE) with a pointer to `dome install`; unsupported
platforms and uid-less macOS environments get the same exit-1 refusal shape
as `dome install` / `dome uninstall`. A failed `bootstrap` / `restart` leaves
the service definition in place, prints the service manager's stderr, and
exits 1.

`--json` emits `dome.restart/v1`: `{ schema, status: "restarted" | "error",
vault, label, plist, error? }`.

Testability matches install: `runRestart` accepts the same injected
`ServiceDeps` (platform, uid, LaunchAgents dir, launchctl runner, plus the
systemd dir and systemctl runner on Linux), so tests drive the
bootout/bootstrap and restart sequences against recording fakes without
touching a real service manager (`tests/cli/install.test.ts`,
`tests/cli/install-systemd.test.ts`).

Exit codes: 0 on a successful restart; 64 (EX_USAGE) when no plist/unit is
installed for the vault; 1 on an unsupported platform, undeterminable uid
(macOS), `launchctl bootstrap` / `systemctl restart` failure, or unexpected
I/O failure.

### `dome mcp [--vault <path>] [--bundles-root <path>]`

Runs the Dome MCP server over stdio for one vault — the shipped protocol
adapter per [[wiki/specs/mcp-surface]] ([[wedge]] §"Phase 5 — MCP server").
The server exposes eight typed tools (`capture`, `query`, `export_context`,
`status`, `check`, `resolve`, `tasks`, `brief`) whose results are the same
JSON documents the corresponding CLI verbs emit under `--json`; the adapter
consumes the same data paths rather than re-implementing them.

Boundary discipline:

- **stdout is the protocol channel.** Tools consume data-returning
  boundaries (the `openVault` wrapper plus the CLI's collectors) — nothing
  in a tool call prints, so command JSON can never corrupt the wire. A
  mutex serializes tool calls (one runtime at a time). Server-side notices
  go to stderr.
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

### `dome http [--vault <path>] [--bundles-root <path>] [--port <port>] [--host <host>] [--token <token>] [--model <id>] [--static-dir <path>] [--allow-write] [--transcribe-cmd <cmd>] [--transcribe-key <key>] [--transcribe-url <url>] [--transcribe-model <model>]`

Runs the Dome HTTP read+capture+converse surface for one vault — the shipped
protocol adapter per [[wiki/specs/http-surface]] and the first shipped form of
the remote-capture seam ([[wiki/specs/capture]] §"The remote-capture seam").
Routes: `POST /capture`, `GET /status`, `GET /query`, `GET /tasks`,
`GET /doc`, `GET /questions`, `POST /resolve` — the same JSON documents the
corresponding CLI verbs emit under `--json` — plus `GET /today` (the
self-refreshing HTML cockpit page; [[wiki/specs/http-surface]] §"The cockpit
page (`GET /today`)"), `POST /agent` (the hosted agent loop; converse
capability), `POST /agent/stream` (SSE variant), `POST /transcribe` (voice
STT; capture capability), and `GET /recents`.

Boundary discipline:

- **Bearer token required.** `--token <value>` or `DOME_HTTP_TOKEN`; the
  verb refuses to start without one (exit 64). Requests without the token
  get 401.
- **Loopback by default.** Binds `127.0.0.1:3663`; `--host` points it at a
  private (Tailscale-class) interface for phone access. Owner trust domain
  only — hosted multi-tenant is v1.5 territory.
- **No compilation.** Same as `dome mcp`: the daemon owns adoption;
  `capture` and `resolve` reuse the non-engine write channels.
- **Write capability opt-in.** `--allow-write` (or `DOME_ALLOW_WRITE=1`)
  grants the agent the `author` write capability (`create_document` /
  `edit_document` → git commit → daemon adopts); default off,
  read-only-safe.

Exit codes: 0 on clean shutdown (SIGINT/SIGTERM); 64 on missing token,
malformed port, or uninitialized vault; 1 on listener failure.

### Planned dedicated view aliases

`dome stats` and `dome migrate` are roadmap commands, not current Commander
bindings. The intended shape is:

- `dome stats` — richer vault analytics beyond the compact `dome status`
  dashboard.
- `dome migrate` — explicit vault/schema upgrade orchestration beyond the
  current open-time SQLite migration and projection rebuild paths.

Until these two ship, their processors would be invoked via `dome run
<command-name>` if they existed today. Every shipped first-party
command-triggered view processor already has a dedicated top-level verb —
`dome query`, `dome export-context`, `dome lint`, `dome today`, `dome prep`,
`dome agenda-with`, `dome stale-claims`, and `dome orphan-pages` — so
`dome run <name>` is reserved for extension-authored view processors under
active development or debugging.

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
useful. Advanced commands (`inspect`, `doctor`, `answer`, `run`, `rebuild`,
`reanchor`)
remain named because they are valuable for debugging, scripting, extension
development, and explicit recovery, not because agents should choose among
them during the daily loop.

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
