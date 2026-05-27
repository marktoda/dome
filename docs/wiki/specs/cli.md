---
type: spec
created: 2026-05-25
updated: 2026-05-26
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]", "[[cohesive/brainstorms/2026-05-26-dome-compiler-reframe]]"]
---

# CLI

This spec is normative for the `dome` command-line interface in v0.5. The CLI is **the primary explicit-operation surface across every consumer shell** — the way both the user (from any terminal) and an agentic harness (via shell-execution: Claude Code's `Bash`, Cursor's equivalent, etc.) invoke named structured operations against a vault. It is also the home for the things neither a chat-shaped harness nor a markdown-shaped browser does well: setup, migration, hook reconciliation, scheduled hygiene, diagnostics, cross-AI context export.

The CLI is intentionally small. **Nine commands** in the shipped SDK; extension bundles can contribute additional bundle-conditional commands per [[wiki/specs/sdk-surface]] §"Extension bundles" (e.g., the first-party `dailies` bundle contributes `dome migrate-dailies` when installed). Each shipped command maps to a concrete user action; commands that would map to "chat-with-the-brain" or "browse-the-vault" do not exist (use a harness or Obsidian respectively). A glanceable summary (`dome stats`) is neither — it's a snapshot of structural state.

## `dome init <path>`

Bootstrap a new vault at `<path>`. Minimal and general-purpose — no profiles, no opt-in features activated beyond the shipped-default tier.

```bash
dome init ~/vaults/research
```

Creates:

- The directory tree: `raw/`, `notes/`, `wiki/{entities,concepts,sources,syntheses}/`, `inbox/raw/` (the shipped-default capture bucket), `inbox/review/` (the shipped-default lint-report destination per [[wiki/specs/vault-layout]]), `.dome/{prompts,hooks,state}/`.
- `.dome/page-types.yaml` with the four default types.
- `.dome/config.yaml` with shipped defaults enabled and opt-in features disabled.
- `.dome/hooks/intake-raw.yaml` — the shipped-default intake hook that processes `inbox/raw/*` via the `ingest` workflow.
- `.gitignore` — excludes `.dome/state/` (per-machine operational state).
- `index.md` and `log.md` (with one bootstrap entry).
- `AGENTS.md` at vault root — the vault-owned, cross-harness convention file. **Canonical orientation surface for agentic harnesses per [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]].** Carries cold-start orientation as templated content: the vault's conventions (page-type-by-directory, wikilinks-fullpath, etc.), the enabled invariant set, the declared page types, the shipped + active workflow names, and a user-editable `## Vault notes` section delimited by HTML comments so `dome doctor --repair` can re-template the scaffolding without touching user prose. Vault-owned: `dome init` writes the initial file; `dome doctor --repair` regenerates the templated sections from current `.dome/config.yaml` + enabled-invariant set + declared page types; user-prose sections are preserved across all `--repair` runs. For harnesses that also mount the MCP server, the MCP `instructions` payload carries an equivalent system-rule render at mount time (see [[wiki/specs/mcp-surface]] §"Session model") as a secondary delivery channel — `AGENTS.md` is canonical, MCP `instructions` mirrors it.
- `CLAUDE.md` at vault root — a thin one-line shim pointing at `AGENTS.md`. Exists only because Claude Code's auto-load convention currently prefers `CLAUDE.md`; removable once `AGENTS.md` auto-load is universal across harnesses.
- **Initializes a git repository** and makes the initial commit (per [[wiki/invariants/VAULT_IS_GIT_REPO]]). The commit message: `chore: initialize Dome vault`. The user starts with a clean working tree and a vault that's immediately ready for use.

Refuses if `<path>` already contains `.dome/` (use `dome migrate` for existing Dome vaults) OR `.git/` with prior history that wasn't created by `dome init` (the user should `dome migrate` instead to inherit their existing history cleanly).

Activating opt-in intake features beyond `intake-raw` (voice intake, research intake, clip intake) is manual after init: copy hook templates from the SDK's `hooks/templates/` into `.dome/hooks/` and create any additional `inbox/<bucket>/` directories. A future "packs" mechanism may layer convenience over this; v0.5 keeps activation explicit.

## `dome migrate <path>`

Convert an existing markdown vault (Obsidian / Foam / plain markdown / a previous-version Dome vault) to current Dome shape.

```bash
dome migrate ~/vaults/work
```

The migration is **a workflow** (`migrate` is a named workflow prompt; see [[wiki/specs/prompts-and-workflows]]). The headless agent loop:

1. Scans the directory; identifies probable categories (raw vs wiki vs notes).
2. Detects existing typed-page layout if present.
3. Proposes a migration plan: which files move, which frontmatter to add, which invariants would be violated and how to fix.
4. Writes the proposal to `<path>/.dome/migration-plan.md` for user review.
5. On user confirmation (`dome migrate <path> --apply`), executes the plan via Dome's Tools — every move and frontmatter add is logged.

This is the v0.5 sleeper feature: the on-ramp that lets users (the author first, others later) bring an existing vault into Dome without a forklift rewrite. Mass-market v1+ depends on this being good.

## `dome serve --vault <path>`

Start the compiler daemon (watcher + reconcile + scheduled-hook clock; optionally also the MCP server) for `<path>`. The daemon is the active layer of the compiler boundary per [[VISION]] §"Two surface patterns" — it catches native writes from consumer shells, fires hooks reactively, and processes scheduled-hook intervals.

```bash
dome serve --vault ~/vaults/work          # stdio, default
dome serve --vault ~/vaults/work --port 7777   # HTTP/SSE (v0.5.1+)
```

The serve command, in order:

1. Opens the vault, loads the registry.
2. **Runs `dome reconcile` automatically** to catch up on any events missed while serve wasn't running (pending inbox files, out-of-band edits, missed scheduled events, uncommitted-state recovery via `git status`). See `dome reconcile` below.
3. Starts the file watcher on `inbox/*/` directories and `wiki/*/` (for out-of-band-edit detection); declarative-hook intakes fire on file writes; reactive hooks (`auto-update-index`, `auto-cross-reference`, watcher-driven `appendLog`) fire on each change.
4. Starts the clock source for scheduled hooks.
5. Starts the MCP server (when MCP is configured for the vault — see [[wiki/specs/mcp-surface]] §"Status in v0.5"). MCP is the optional protocol-server overlay; the daemon's primary work (steps 3–4) does not depend on it.
6. Runs until killed.

If the auto-reconcile at step 2 fails (e.g., vault is mid-merge — see [[wiki/gotchas/dirty-git-state-at-reconcile]]), serve refuses to start with a clear error.

**Deployment.** The canonical pattern is to run `dome serve` as a launchd / systemd service: continuous compilation, the watcher catching every native write in real time, scheduled hooks firing on their intervals. Claude Code (or any other agentic harness) interacts with the vault via the four surfaces of the compiler-boundary contract (AGENTS.md + CLI + daemon + reconcile) per [[wiki/specs/harnesses]] §"The compiler-boundary contract"; it does not spawn the daemon itself. For harnesses that mount the optional MCP server, the harness can configure `dome serve` to launch as a child process — see [[wiki/specs/harnesses]] §"Claude Code" for the MCP-mount configuration example. v0.5 documents the launchd / systemd setup pattern; v1+ may ship a service installer.

## `dome reconcile`

Catch up the vault's hook execution state to match the current filesystem state. Run automatically by `dome serve` at startup; can be invoked manually when serve isn't running or after an out-of-band sync (e.g., `git pull`).

```bash
cd ~/vaults/work && dome reconcile
```

Runs three phases in order (see [[wiki/specs/hooks]] §"Durability and reconciliation" for full detail):

1. **Inbox processing** — fire `document.written.inbox.<bucket>` for each file in `inbox/<bucket>/`. Intake hooks move the files out on completion (per [[wiki/invariants/INBOX_IS_EPHEMERAL]]).
2. **Git diff** — fire `document.written.<category>.<type>` for each file changed since `.dome/state/last-reconciled-sha.txt`, using `git status --porcelain` + `git diff --name-only`.
3. **Scheduled catch-up** — fire `clock.tick.<interval>` for each scheduled hook whose interval has elapsed.

(No in-flight-recovery phase — see [[wiki/specs/hooks]] §"Crash recovery without lockfiles" for why per-workflow atomic commits + idempotency contract cover every recovery case.)

Refuses to run if the vault is mid-merge, mid-rebase, or mid-cherry-pick — see [[wiki/gotchas/dirty-git-state-at-reconcile]] for the detection and the recovery path.

Exit codes: 0 on success; nonzero if reconciliation could not complete (dirty git state, missing `.git/`, corrupted state files). Output: a summary of the events fired and hooks completed per phase.

## `dome lint`

Run the `lint` workflow against the vault. Two modes: **propose** (default) writes a report of detected drift; **apply** (`--apply <id>`) executes a single named recommendation from the most recent report. The shape parallels `dome migrate` — propose first, apply on confirmation — and uses the same Tool surface as migrate (`writeDocument`, `moveDocument`, `deleteDocument`) so a lint finding can rewrite a page, rename an entity, or retire an orphan as the recommendation dictates.

### Propose mode (default)

```bash
cd ~/vaults/work && dome lint
```

Invokes the `lint` workflow prompt via the headless agent loop:

1. Reads the wiki and index.
2. Detects: orphan pages, stale claims, missing cross-references, contradictions, schema-violating frontmatter, out-of-band direct edits.
3. Writes a structured report. Each finding carries a **stable id** (`<severity-letter><index>`: `H1`, `H2`, `M1`, `L1`; severities `H`igh / `M`edium / `L`ow), an optional `(advisory)` tag for findings that require human judgment the workflow cannot execute on its own (apply mode refuses these — see below), a one-line title, an Evidence paragraph with `path:line` references, and a Recommendation paragraph concrete enough that a re-invocation of this workflow can execute it without re-deriving intent.
4. Writes the report to `inbox/review/lint-report-YYYY-MM-DD.md` (the `inbox/review/` directory is shipped-default per [[wiki/specs/vault-layout]] — created by `dome init`). Repeat runs on the same date append a `Pass N` section to the existing file rather than overwriting — same-day re-runs produce a longitudinal log.
5. Exits 0 if no findings above the configured severity threshold; nonzero otherwise.

The user reviews the report in Obsidian (or any markdown editor) and decides which findings to apply.

### Apply mode (`--apply <id>`)

```bash
cd ~/vaults/work && dome lint --apply H1
cd ~/vaults/work && dome lint --apply H1 --apply H2   # multiple ids, applied in order
```

Re-invokes the `lint` workflow with the named finding id(s) as its user message:

1. Locates the most recent lint report under `inbox/review/lint-report-*.md` (lexically newest filename — reports are dated).
2. Finds the finding whose id matches `<id>` (most-recent `Pass N` section wins if the same id appears in multiple passes).
3. Executes the recommendation via Dome's Tools (`writeDocument`, `moveDocument`, or `deleteDocument` as the recommendation requires). Every mutation is logged per [[wiki/invariants/EVERY_WRITE_IS_LOGGED]].
4. Appends an `**Applied:** YYYY-MM-DDTHH:MM:SSZ` annotation (bold-marked, ISO-8601 UTC) to the originating finding's entry in the report (idempotent: a re-apply against an already-applied finding refuses with exit nonzero rather than mutating twice). On failure, the annotation is `**Apply-failed:** YYYY-MM-DDTHH:MM:SSZ — <reason>` (same bold/timestamp shape; reason follows after an em-dash).
5. Exits 0 on success; nonzero if (a) the finding id is absent from the most recent report, (b) the recommendation cannot be safely executed (target moved out of band, conflicting newer state), (c) the report itself is missing, or (d) the finding is marked `(advisory)` and requires human judgment outside the workflow's scope. Failed applies record an `Apply-failed: <reason>` annotation on the finding before exiting.

When multiple ids are passed (`--apply H1 --apply H2`), apply proceeds through the list independently; a per-id failure does not abort the remaining ids. The CLI exits nonzero if any id failed, with a per-id summary on stderr naming each id's outcome (applied / failed / refused).

Refuses to run if the vault is mid-merge / mid-rebase — same guard as `dome reconcile` per [[wiki/gotchas/dirty-git-state-at-reconcile]]. Applied findings produce ordinary git-tracked writes; `git revert` is the universal undo.

### Periodic operation

Propose mode is designed to be cron'd weekly (per the workflow's `clock:weekly` trigger in [[wiki/specs/prompts-and-workflows]]). Apply mode is interactive: a user reviews each report and selectively applies findings. Scheduled apply is intentionally not supported in v0.5 — fixes that mutate the vault should pass through a human.

## `dome doctor`

Diagnose the vault's structural health.

```bash
cd ~/vaults/work && dome doctor
```

Unlike `dome lint` (semantic / agent-driven), `dome doctor` is deterministic: it walks the vault and reports structural violations:

- Pages whose `type:` frontmatter doesn't match their directory.
- Pages with frontmatter fields not in the page-type schema.
- Wikilinks that don't resolve.
- Wikilinks not in full-path form.
- Pages in `wiki/<unknown-subdir>/`.
- Raw files modified after creation (suggests something bypassed `RAW_IS_IMMUTABLE`).
- `log.md` non-monotonic timestamps.
- `.dome/page-types.yaml` declares extensions not used; or pages use types not declared.
- Inbox files older than `hooks.inbox_stale_age_hours` (see [[wiki/invariants/INBOX_IS_EPHEMERAL]]) — `inbox/review/` is excluded because `review/` is a destination, not an intake.

Exit 0 if clean; nonzero with a report otherwise. Suggests fixes; doesn't apply them. Run after `dome migrate` to verify; run before opening to a new harness to verify upstream changes didn't drift.

**Flags:**

- `--rebuild-index` — calls `dispatcher.writeIndex` directly to regenerate the full `index.md` from the wiki/ contents. Used when `auto-update-index` is disabled (so the index has gone stale) or when the user wants a from-scratch rebuild. The dispatcher's privileged API is the only mutation path for `index.md` per [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]]; `writeDocument` refuses `index.md` unconditionally.
- `--show review-queue` — list pending items in `inbox/review/` (lint reports awaiting human review per [[wiki/specs/cli]] §"`dome lint`").
- `--time-since-reconcile` — report how long it's been since `dome reconcile` last ran successfully (read from `.dome/state/last-reconciled-sha.txt` mtime). Surfaces drift age so the user knows whether `dome serve` is keeping up. See [[wiki/gotchas/daemon-off-while-vault-mutating]].
- `--show raw-citations` — list which wiki pages cite each raw source (derived from `sources:` frontmatter on wiki pages; not a stored index).
- `--show workflows` — list the resolved workflow set (shipped defaults + plugin + vault-local overrides), with their bound tool subsets and triggers.
- `--show events` — list the resolved event taxonomy (Effect-derived + lifecycle), including plugin-registered events.
- `--show recent-hook-cycles` — list recent `hook.cycle-detected` events with their full causation chains. Useful for diagnosing hook design errors.
- `--recent-activity [N]` — list the last `N` writes by tool and target (default 50). Useful for spotting prompt-regression drift after a model upgrade or prompt edit.
- `--drain-hooks` — block until the async hook queue drains, then exit. Useful when the user wants to read post-hook state immediately (e.g., right after a write, before a query).
- `--reset-quarantined-hooks` — clear the hook-quarantine list. Handlers are quarantined after three consecutive failures per [[wiki/specs/hooks]] §"Execution model"; use this flag after fixing a misbehaving hook to bring it back into rotation. Operates on `.dome/state/quarantined.json` (see [[wiki/specs/vault-layout]] §"Derived operational state under `.dome/`") — that file is the authoritative quarantine record across CLI invocations, since `dome doctor` and `dome serve` don't share a process.

## `dome stats`

Print a visually appealing, read-only dashboard summarizing the vault's structure and activity. No LLM; deterministic; safe to run anywhere `dome doctor` is safe.

```bash
dome stats                # colored dashboard to stdout (default)
dome stats --json         # JSON to stdout, no colors
dome stats --vault <path> # override CWD vault detection
```

The dashboard shows:

- **Page counts** by type — entities, concepts, specs, invariants, matrices, syntheses, gotchas, and any custom page-type extensions declared in `.dome/page-types.yaml`.
- **Wikilink graph health** — total link count and orphan count (full-path links whose target file doesn't exist).
- **Raw files** — count and total bytes.
- **Log activity** — total entries and age of the most recent entry (`Nm ago` / `Nh ago` / `Nd ago`).
- **Top hubs** — the 3 most-linked-to pages.
- **Git** — vault age in days, total commits, distinct contributor count.

`--json` emits the same data as a structured object whose shape (`VaultStats`) is the stable serialization contract for cross-tool consumption.

When the vault sits inside a larger git repo (the dogfood case), git stats reflect the outer repo's history. v1 documents this; a future `--commit-scope <vault|repo>` flag could specialize.

Exit code is 0 on success, 1 if vault open fails, 2 on usage error. A future `dome stats graph` subcommand will add a knowledge-graph visualization; v1 ships only the dashboard.

## `dome run-hook <id>`

Manually invoke a registered hook by ID. Synthesizes a `hook.manual.invoked` event with the hook's ID + caller-supplied payload in the event body; the dispatcher matches the event against the named hook and runs its handler.

```bash
dome run-hook compile-daily --event.path=wiki/dailies/2026-05-26.md
dome run-hook dailies:create-daily       # force-fire the dailies bundle's scheduled creator now
dome run-hook auto-update-index --event.path=wiki/entities/danny.md
```

Useful for:

- **Backfill** — fire a schedule-driven hook outside its cron interval (e.g., create a daily for a missed past date by passing the date in the event payload).
- **Dogfood** — exercise a newly-installed hook without waiting for its natural trigger.
- **Integration testing** — synthesize known-input events against the dispatcher to verify hook behavior.

**Flags:**

- `--event.path=<path>` — set the event's `path` payload field. Required for hooks that filter on `path_pattern`.
- `--event.payload-json=<json>` — set the event's full payload as a JSON object (merged with `--event.path` if both are passed; `--event.path` takes precedence on key collision).
- `--vault <path>` — override CWD vault detection.

Refuses if the named hook is not registered (lists available hook IDs in the error). Refuses if the hook is quarantined per [[wiki/specs/hooks]] §"Execution model" (suggests `dome doctor --reset-quarantined-hooks`). Refuses if the vault is mid-merge / mid-rebase per [[wiki/gotchas/dirty-git-state-at-reconcile]].

Exit codes: 0 if the hook fires and its handler completes successfully; 2 on usage error (unknown hook, quarantined hook, malformed payload JSON); nonzero on handler failure (the failure is also logged to `log.md` per the standard hook-failure path).

Manually-invoked hooks are NOT subject to the idempotency contract's reconcile-skip semantic — they fire regardless of the hook's `idempotent:` declaration. The user invoking `dome run-hook` is asserting "I want this to run now"; suppressing the fire because the hook is non-idempotent would defeat the command's purpose. Use with care on hooks with external side effects.

## `dome export-context <topic>`

Produce a markdown context-packet for cross-AI handoff.

```bash
cd ~/vaults/work && dome export-context "platform team ownership"
```

Invokes the `export-context` workflow:

- Identifies relevant pages by topic.
- Reads their content.
- Composes a markdown blob with sections (entities involved, current synthesis, open questions, related decisions, source trail).
- Writes to stdout (pipeable) or to a named file with `--out <path>`.

This is the antidote to pinned-thread chaos: paste the output into ChatGPT / Cursor / a new Claude Code session and resume thinking with full context. Particularly useful when switching AI tools mid-task.

## What's not a CLI command

| Action | Why no CLI | Use this instead |
|---|---|---|
| `dome capture <text>` | Quick capture IS just a write to `inbox/raw/<ts>.md`; the intake hook does the rest. No special Dome command needed. | `echo "$THOUGHT" > $VAULT/inbox/raw/$(date -u +%Y%m%d-%H%M%S).md` |
| `dome chat` | Chat surface lives in the harness (Claude Code). Dome is the layer beneath. | `claude` (in a vault directory with Dome MCP configured) |
| `dome browse` | Browsing markdown is what Obsidian / vim / any editor does well. | Obsidian on the vault path |
| `dome query <q>` | Query lives in a chat harness. CLI version would just shell out to the same workflow. | Ask in your harness |
| `dome import-obsidian` | Subsumed by `dome migrate` (auto-detects Obsidian structure) | `dome migrate` |
| `dome backup` | Vault is git-backed; backup is `git push`. | `cd $VAULT && git push` |

## Adding a new command

Adding a tenth shipped `dome <foo>` command is **five file edits**, paralleling the "Adding a 9th Tool is two file edits" recipe at [[wiki/specs/sdk-surface]] §"Tool catalog is one declarative array":

1. **Implement `domeFoo(path, opts): Promise<Result<FooReturn, CliError>>`** at `src/cli/commands/foo.ts`. Workflow-driven commands invoke `runWorkflowAtPath` from `@dome/sdk/workflows`; deterministic commands consume `vault.tools.*` directly. The signature shape mirrors the existing nine `domeX` exports.

2. **Wire the Commander arm** in `src/cli/cli.ts` `buildProgram` — `program.command("foo").description(...).option(...).action(async (...) => { ... domeFoo(path, opts) ... })`. If the command is workflow-driven, gate it with `requireApiKey()` before the action body runs (the `@dome/sdk/cli` pre-flight pattern at `src/cli/api-key-guard.ts`).

3. **Re-export `domeFoo`** from `src/cli/index.ts`. The `cli-shell-shape` lockstep test (`tests/integration/cli-shell-shape.test.ts`) enumerates implementations in `src/cli/commands/` and asserts each is re-exported from `src/cli/index.ts` — a missed export fails the test.

4. **Update this spec.** Add a `## dome foo` section above with the input contract, exit behavior, and example invocation; update the command-count summary above ("nine commands today") and the §"Implementation note" command-mapping table.

5. **Add an end-to-end test** at `tests/integration/end-to-end.test.ts` covering one happy path.

`CliError = ToolError | MissingApiKeyError` is the typed error surface — extend it (not `ToolError`) when a new command introduces a consumer-shell-specific error kind. Pre-flight failures belong on `CliError`; Tool failures belong on `ToolError`. The pass-3 architecture review's §"Adding a CLI command" recipe is the canonical source for this surface; if a future command needs a sixth file edit, this section grows to enumerate it explicitly.

### Bundle-contributed commands

Extension bundles contribute CLI commands via `<vault>/.dome/extensions/<bundle>/cli/<command>.ts` per [[wiki/specs/sdk-surface]] §"Extension bundles". Bundle-contributed commands are **bundle-conditional** — they exist only when the bundle is loaded. The shipped SDK CLI surface stays stable at nine commands; bundles grow the runtime surface independently.

A bundle-contributed command follows the same `domeFoo(path, opts) → Result<FooReturn, CliError>` signature as shipped commands. The bundle loader registers each `<bundle>/cli/*.ts` into the `runCli` command set after vault-local `.dome/cli/*.ts` files; collisions across bundles or with shipped commands abort the load with a `bundle-load-failure` per [[wiki/gotchas/extension-bundle-load-order]]. The first-party `dailies` bundle's `migrate-dailies` command is the canonical example.

Bundle commands appear in `dome --help` output after the SDK's shipped commands; the help text reads from each bundle's CLI file's `description` export. The lockstep test at `tests/integration/extension-bundles-load.test.ts` includes a CLI-command-registration assertion against the test fixture's bundle.

## Implementation note

CLI commands implement to a single pattern: parse args, open the vault, dispatch to either (a) a Tool sequence (deterministic: `init`, `doctor`, `serve`, `reconcile`, `stats`, `run-hook`) or (b) a workflow via the headless agent loop (LLM-driven: `migrate`, `lint`, `export-context`). The CLI itself is < 700 LOC; most of the work lives in the workflows and Tools.

### The shared `--apply` idiom

Workflow-driven commands that produce proposals (a migration plan, a lint report) share the `--apply` flag as the user's confirmation gesture — *"you previously proposed something; now execute it."* The type varies with the granularity of the proposal:

- `dome migrate --apply` — boolean. The migration plan is a single artifact; `--apply` executes it whole.
- `dome lint --apply <id>` — repeatable string. Lint reports carry per-finding ids (`H1`, `M2`, ...); `--apply <id>` targets one, repeatable for multi-id.

The shared flag name signals shared semantics (propose-then-apply); the divergent type signals divergent granularity (whole-plan vs per-finding). A future per-step targeting on migrate (or `--apply --all` on lint) is the moment to revisit naming; for v0.5, the consistent vocabulary across workflow commands is worth more than perfectly-disjoint flag names.

### Errors at the consumer-shell boundary

Core `ToolError` (in `src/types.ts`) enumerates failures the eight Tools and `openVault` can produce. Consumer shells layer their own pre-flights on top: the CLI has `MissingApiKeyError` (raised when `ANTHROPIC_API_KEY` is unset before an LLM-driven command runs), and exposes the union as `CliError = ToolError | MissingApiKeyError`. `renderCliError` is the default one-line stderr formatter; other consumer shells (Electron, web, voice — v1+) can reuse it or supply their own. Keeping shell pre-flights out of core `ToolError` preserves the SDK-vs-consumer boundary: a shell with no env vars (mobile, web) doesn't carry an error kind it can't produce.

The 9 shipped commands map cleanly to user actions:

| Command | Kind | When the user reaches for it |
|---|---|---|
| `dome init` | deterministic | First setup of a new vault |
| `dome migrate` | workflow | Adopting Dome for an existing markdown vault |
| `dome serve` | deterministic (with auto-reconcile at startup) | Running the compiler daemon (watcher + reconcile + hooks; optional MCP server) — typically a launchd / systemd service |
| `dome reconcile` | deterministic | Catching up after `dome serve` was off (intakes pending, out-of-band edits, missed schedules) |
| `dome lint` | workflow | Periodic vault hygiene (weekly cron or manual); apply via `dome lint --apply <id>` |
| `dome stats` | deterministic | Glanceable snapshot of structural state (page count, hubs, log activity, contributors) |
| `dome doctor` | deterministic | Diagnostic structural check (no LLM) |
| `dome run-hook` | deterministic | Manually fire a registered hook (backfill, dogfood, integration test) |
| `dome export-context` | workflow | Cross-AI handoff (paste context into ChatGPT / Cursor / etc.) |

Bundle-conditional commands (present when the named bundle is loaded) include `dome migrate-dailies` (from the `dailies` bundle); see [[wiki/matrices/extension-bundle-shape]] for the full catalog.

## Related

- [[wiki/specs/sdk-surface]] — the Tools the CLI dispatches against.
- [[wiki/specs/mcp-surface]] — the optional MCP protocol-server overlay `dome serve` launches when MCP is configured.
- [[wiki/specs/prompts-and-workflows]] — workflows invoked by `migrate`, `lint`, `export-context`.
- [[wiki/specs/harnesses]] — the compiler-boundary contract (AGENTS.md + CLI + daemon + reconcile) agentic harnesses interact with.
