---
type: synthesis
created: 2026-05-28
updated: 2026-05-29
sources:
  - "[[wiki/specs/harnesses]]"
  - "[[wiki/specs/cli]]"
  - "[[wiki/specs/processors]]"
  - "[[wiki/specs/processor-execution]]"
  - "[[wiki/matrices/intent-prompt-processors]]"
status: draft
tags: ["plan", "v1", "claude-code", "roadmap"]
---

# v1 Claude Code vault plan

This is the explicit v1 plan for the product we are actually trying to make usable first: a git-backed markdown vault that Claude Code can work inside every day, with Dome running as the compiler runtime and garden.

Companion technical plan: [[v1-roadmap]]. This document is the product contract and acceptance framing; the roadmap is the updatable engineering ledger for shipped status, implementation order, dependency slices, and tests. Keep them reconciled.

## Product thesis

The v1 product is not an agent tool collection. Claude Code already has strong read, write, search, shell, and git tools. Dome's v1 job is to make normal Claude Code vault work compound:

1. The user opens Claude Code in a Dome vault repo.
2. `CLAUDE.md` orients Claude with vault conventions and tells it when to commit and when to check Dome.
3. Claude talks with the user, edits markdown, and creates normal git commits.
4. A Dome compiler host notices committed branch movement, runs adoption, and advances `refs/dome/adopted/<branch>` only after the engine reaches a clean fixed point.
5. Garden processors run after adoption: update derived facts, normalize metadata, create/carry-forward daily notes, extract tasks/followups, compile captures, update links, refresh search, and surface diagnostics.
6. When automation cannot safely proceed, Dome records a diagnostic or asks a question. The user answers through one operational channel.

The practical promise is: "Talk to Claude Code about my day; let it edit and commit the vault; Dome reliably does the gardening afterwards." The runtime may be foreground, background, or hosted. That is an operating choice, not the core architecture.

## First-principles boundaries

### Claude Code is the primary interaction surface

The primary v1 interface is Claude Code sitting inside the vault repository. That means:

- The vault must carry `CLAUDE.md`, or a `CLAUDE.md` shim importing `AGENTS.md`, because Claude Code reads `CLAUDE.md` rather than `AGENTS.md`.
- The instructions must be short and operational: write markdown, commit meaningful changes, run `dome status`/`dome sync` when the user wants to wait for adoption, inspect diagnostics/questions when Dome reports trouble.
- Dome should not assume Claude needs a bespoke write API. Native file edits plus git are the write path.

External reference: Claude Code documents `CLAUDE.md` as the persistent project instruction surface and recommends importing `AGENTS.md` from `CLAUDE.md` when a repo uses both conventions: <https://code.claude.com/docs/en/memory>.

### The compiler runtime is the product path

The highest-value path is not `dome query`; it is a reliable compiler runtime that can be hosted in several ways:

```text
git commit by user/Claude
  -> compiler host sees HEAD move
  -> adoption processors validate/normalize/index deterministic state
  -> adopted ref advances
  -> garden processors run async follow-on work
  -> garden PatchEffects become sub-Proposals and go through adoption
  -> diagnostics/questions/outbox/runs explain what happened
```

`dome sync` is the blocking/manual version of the same flow. It exists for "I want to wait until Dome catches up" and for users who do not keep a long-running host open.

`dome serve` should be the first long-running host, but v1 should not hard-code "background daemon" as the conceptual model. A foreground, LSP-like process that runs while the user is in Claude Code can be just as valid:

| Host mode | Shape | Why it exists |
|---|---|---|
| One-shot | `dome sync` | Explicit catch-up, scripts, CI, host-off recovery. |
| Foreground compiler | `dome serve` in a terminal/session, visible logs, fast status | Best early dogfood mode; feels like an LSP/watch process attached to the vault. |
| Local background service | launchd/systemd wrapping `dome serve` | Enables quiet scheduled work, mobile/web clients on the same machine, and no need to remember startup. |
| Embedded/server host | future local HTTP/MCP/WebSocket host over the same runtime | Enables native mobile, desktop, and web surfaces without changing the engine boundary. |
| Hosted queue | future cloud/GitHub-like queue | Coordinates remote clients, PR-like proposals, engine patches, conflict resolution, and protected merges. |

The engine should therefore be factored as `open runtime -> drive adoption/operational work -> expose status/query/recovery`, with process hosting layered around it.

### CLI is mostly control and visibility

Most CLI commands are not things Claude should call constantly. The CLI should be split by real use:

| Tier | Commands | Purpose |
|---|---|---|
| Load-bearing | `dome serve`, `dome sync`, `dome status` | Drive the compiler runtime; let Claude/user wait for adoption; show whether the vault is healthy. |
| Recovery | `dome inspect`, `dome doctor`, `dome answer` | Explain and resolve stuck engine work. |
| User-value views | `dome query`, `dome lint`, `dome export-context`, `dome today`, `dome prep` | Explicit views when the user asks for them. |
| Admin/dev | `dome rebuild`, `dome migrate`, `dome run`, future low-level run-processor | Maintenance, testing, escape hatches. |

The v1 CLI should not be a huge command zoo Claude is expected to remember. `CLAUDE.md` should teach only the load-bearing and recovery commands by default, plus a small list of named views.

### MCP is not the v1 value path

MCP is useful for harnesses that lack shell access or need typed read/query calls. It is not the main v1 path for Claude Code. Claude Code already has native filesystem, grep, shell, and git tools; adding a Dome MCP write/read layer risks duplicating better-native affordances.

For v1, MCP should be additive and read-oriented if present. It should not block v1, and it should not introduce privileged write tools.

External reference: Claude Code supports MCP servers, but also treats them as optional integrations configured separately from project memory and native tools: <https://code.claude.com/docs/en/mcp>. MCP tools are a protocol mechanism for model-invoked server actions, not a reason to duplicate a good local shell contract: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>.

### Hooks are optional session affordances

Claude Code hooks can help a foreground workflow, for example by reminding the user to commit or by running `dome status` after a successful `git commit`. They should not become Dome's semantic substrate. Dome's canonical semantics remain git commits, adoption, processors, effects, and the run ledger.

External reference: Claude Code's hook system can intercept tool lifecycle events such as `PreToolUse` and `PostToolUse`, but it is a harness-specific automation layer: <https://code.claude.com/docs/en/hooks>.

### Hosted merge queue is v1.5 runway

The local v1 engine should be designed so a hosted merge queue is natural later, but v1 should not depend on a cloud service.

The hosted shape is:

```text
PR / branch / remote client proposal
  -> queue creates synthetic merge candidate against current target
  -> engine runs adoption on that candidate
  -> engine pushes closure/garden patches onto the proposal branch or a queue ref
  -> checks pass
  -> queue fast-forwards or merges
  -> blocked/conflicted proposals ask for human decision
```

This matches established merge-queue/merge-train systems: they validate a PR's changes when applied to the latest target plus earlier queued changes, not merely against stale branch state. GitHub's merge queue and GitLab merge trains both frame the core value this way: protect a busy branch from incompatible changes while avoiding manual rebase churn.

External references: GitHub merge queues validate queued changes against the latest target branch and earlier queue contents (<https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>); GitLab merge trains compare queued merge requests together so they work as a sequence (<https://docs.gitlab.com/ci/pipelines/merge_trains/>).

## Runtime host requirements

All host modes should share one engine boundary. A foreground watch process, a background daemon, and a future app server should not implement three subtly different compilers. They should all call the same runtime operations:

```text
openVaultRuntime
  -> detect branch/adopted drift
  -> adopt proposal if drift exists
  -> run garden phase
  -> run due operational work
  -> expose status/query/recovery views
  -> close/drain cleanly
```

The host layer owns process concerns:

- debounce/coalesce repeated branch movements,
- avoid concurrent adoption for one branch,
- keep operational work from stampeding when processors create follow-on commits,
- expose readable logs/status,
- handle shutdown and drain,
- provide local IPC/HTTP/WebSocket later if mobile/web surfaces need it.

The engine layer owns semantics:

- Proposal construction,
- fixed-point adoption,
- capability-checked effects,
- garden sub-Proposals,
- run ledger/outbox/projection writes,
- questions and recovery state.

External prior: file/trigger systems such as Watchman coalesce changes and avoid overlapping trigger execution; merge queues validate synthetic future states rather than mutating the target branch opportunistically. Dome should borrow both ideas without coupling to either product.

## Current state

Shipped and strong:

- Four-concept engine model is real: Proposal, Processor, Effect, adopted ref.
- Adoption loop, garden sub-Proposals, scheduler, JobEffect routing, outbox dispatch, run ledger, projection store, and capability broker exist.
- `dome init`, `dome serve`, `dome sync`, `dome status`, `dome inspect`, `dome run`, and `dome rebuild` exist.
- Processor execution boundary is now much tighter: timeouts, cancellation, output validation, nominal model errors, nominal transient processor errors, and quarantine.
- Current first-party assets include `dome.markdown`, `dome.graph`, `dome.search`, `dome.health`, `dome.daily`, and a minimal `dome.lint`.

Not yet at v1:

- `dome answer` records QuestionEffect answers and dispatches answer handlers, `dome query` ships deterministic adopted-state search, `dome doctor` renders probe-only findings, and failed outbox rows, quarantines, and orphan runs are recoverable through first-party `dome.health` questions. Export-context retrieval is still missing.
- The first-party bundle matrix is partly aspirational. `dome.search` now ships deterministic FTS indexing and `dome query`; `dome.health` now ships failed-outbox retry/abandon, quarantined-processor reset, and orphan-run recovery; `dome.daily` now ships deterministic daily creation, task carry-forward, and explicit daily task/followup fact indexing. `dome.intake`, `dome.index`, `dome.log`, and `dome.migrate` are not shipped as described.
- The day-to-day workflows the user wants are only partially implemented: daily note creation, carry-forward tasks, and explicit daily task/followup fact indexing work, but capture compilation, richer todo/followup extraction, and review questions remain.
- Quarantine exists and is inspectable/resettable through first-party `dome.health` questions, but the backing store is still JSON rather than a richer operational database.
- `AbstractSurface` and MCP docs are ahead of implementation and should not drive the v1 acceptance gate.

## v1 acceptance scenario

A v1 release is good enough when this scenario works on a real vault:

1. `dome init ~/vaults/work` creates a git repo, `.dome/config.yaml`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, and an initial commit.
2. User starts a compiler host: foreground `dome serve --vault ~/vaults/work`, a local background service, or future embedded app host.
3. User opens Claude Code in `~/vaults/work`.
4. Claude reads `CLAUDE.md`, understands the vault conventions, talks with the user about the day, writes a daily note/capture/project note, and commits.
5. Dome adopts the commit, records runs/effects, advances the adopted ref, and runs garden work.
6. Garden work creates or updates:
   - today's daily note,
   - carried-forward incomplete tasks from yesterday,
   - extracted todos/followups from the conversation/capture,
   - wikilink/fact/search projections,
   - diagnostics for broken or ambiguous state.
7. If a processor needs a human decision, `dome inspect questions` shows it and `dome answer` resolves it.
8. If a processor or external action is stuck, `dome doctor` explains it and points to the same answer/retry flow.
9. Claude can optionally run `dome status`, `dome sync`, `dome inspect diagnostics`, `dome query <topic>`, or `dome export-context <topic>` when the user asks for an explicit check or recall packet.

## CLI shape for v1

### `dome serve`

Primary local compiler host. In v1, this can be used foreground like an LSP/watch process or backgrounded by the OS. It should be boring and durable:

- starts fast,
- keeps a single vault open,
- watches HEAD/adopted drift,
- runs operational work on a cadence even when no new commits land,
- logs one-line summaries by default,
- has a verbose/debug mode for development,
- shuts down cleanly.

V1 should include foreground usage docs first. Background launchd/systemd guidance is valuable, but it is not the only valid runtime mode.

### `dome sync`

Blocking catch-up command. Claude should run this only when the user wants immediate confirmation that the latest commit is adopted or when `dome serve` is not running.

Output should be optimized for agents:

- exit 0 when adopted or already in sync,
- exit nonzero when blocked,
- concise text by default,
- structured `--json` for tools.

### `dome status`

The health pulse. This should answer:

- current branch,
- HEAD,
- adopted ref,
- pending commits,
- dirty/merge/rebase state,
- unresolved diagnostics count,
- open questions count,
- failed outbox count,
- quarantined processor count,
- recent failed runs count,
- whether `dome serve` appears stale/off if detectable.

Claude can call this at the beginning or end of a session, but it should not be required for every edit.

### `dome inspect`

Read-only operational substrate. V1 subjects:

- `diagnostics`
- `questions`
- `outbox`
- `runs`
- `quarantine`

This is mostly for debugging and recovery, not daily happy-path use.

### `dome answer`

The universal human-decision channel. The current implementation can print a
question, validate a choice, record an answer by row id, and dispatch matching
garden-phase answer handlers through normal Effect routing. Failed outbox rows,
quarantines, and orphaned running rows are recoverable through first-party
`dome.health` answer handlers. Complete v1 still needs broader user-decision
flows for intake/daily ambiguity; the durable answer store already keeps answer
records outside rebuildable projection state.

The rule: do not create one-off commands like `dome replay-outbox-row` or `dome clear-quarantine`. Instead:

1. engine/health processor emits a question,
2. user answers,
3. answer-handler processor applies the mutation.

### `dome doctor`

The health report, not an admin grab bag. The current CLI renders on-demand
probe findings for failed outbox rows, orphan running rows, and quarantined
processors. Complete v1 can add persisted `dome.health` findings and
`--repair`, but repair remains limited to safe deterministic work or
question/answer-mediated mutations.

### `dome query`

`dome query` should not try to replace `rg` or Claude's ability to read files. Its job is adopted-state recall with evidence:

- search the adopted snapshot and projection store, not arbitrary working-tree drafts,
- return paths, snippets, facts, tasks, diagnostics, open questions, and SourceRefs,
- optionally render an LLM summary, but only over retrieved evidence,
- never mutate state.

Good uses:

- "What did I decide about platform ownership?"
- "What open tasks mention Danny?"
- "What did I say yesterday about the vendor renewal?"
- "Show source-backed context for the Q3 planning thread."

Poor uses:

- replacing `grep`,
- chatting with the user,
- writing files,
- being required for Claude to understand the vault when normal file reads are enough.

Initial v1 can be FTS + fact/task filters with source snippets. LLM narrative rendering can follow once model cost caps and provenance are solid.

### `dome lint`

Explicit audit/report command. It is useful when the user asks "clean up the vault" or before sharing/exporting a context packet. The background engine should still emit important diagnostics automatically.

### `dome export-context`

High-value Claude workflow command. It should produce a portable, source-backed markdown packet for handing a topic to another AI session or product. This is more important than MCP for the near-term multi-agent story.

### `dome rebuild`, `dome migrate`, `dome run`

Admin/dev surfaces. They should exist, but they should not be taught as normal Claude Code behavior except when troubleshooting.

## First-party bundle cut

V1 should ship a smaller bundle set than the aspirational matrix, but each shipped bundle should work end to end.

### Required for v1 daily value

| Bundle | Why it matters | Key processors |
|---|---|---|
| `dome.markdown` | deterministic hygiene and adopted-state confidence | frontmatter normalization/lint, wikilink diagnostics |
| `dome.graph` | link/fact substrate for recall | wikilink facts, entity/task facts |
| `dome.search` | adopted-state recall | FTS indexing and `dome query` shipped; `export-context` remains |
| `dome.daily` | user's stated daily workflow | create daily, carry-forward tasks, index explicit daily task/followup facts, extract richer followups, today/prep views |
| `dome.intake` | "talk about my day" capture compilation | raw capture extraction, todo/followup extraction, question emission |
| `dome.health` | trust and recovery | orphan runs, outbox failures, quarantine, schema skew, instruction drift |

### Optional or later

| Bundle | Recommendation |
|---|---|
| `dome.lint` | Ship if it adds concrete cleanup value beyond markdown diagnostics; otherwise make it a thin report over diagnostics. |
| `dome.index` | Defer unless `index.md` is truly part of the user's navigation loop. Search/graph may be more valuable. |
| `dome.log` | Defer or make append-only minimal. The run ledger already records engine history; a markdown log is useful only if humans read it. |
| `dome.migrate` | Ship when schema/version churn requires it. Until then, keep migrations internal and idempotent. |

## Implementation sequence

### Milestone 0: v1 cut and doc cleanup

- Keep this plan as the canonical v1 product scope document.
- Keep [[v1-roadmap]] as the technical execution plan and shipped-status ledger.
- Update `docs/index.md` to link both.
- Mark aspirational matrices as roadmap when they name unshipped bundles.
- Fix Claude Code orientation docs: `CLAUDE.md` shim is v1.
- Reword MCP as optional/additive until the implementation exists.

Acceptance:

- A contributor can read `docs/index.md` and understand what v1 must ship versus what is v1.5/v2.

### Milestone 1: Claude Code boot path

- Keep `dome init` writing `AGENTS.md` and `CLAUDE.md`, where `CLAUDE.md` imports `AGENTS.md`.
- Keep the generated instructions short enough for daily Claude Code use:
  - edit markdown normally,
  - commit meaningful changes,
  - rely on `dome serve`/`dome sync` for adoption,
  - use `dome status`/`inspect` only for health/recovery,
  - do not edit `.dome/state/`.
- Maintain the integration test that opens a freshly initialized vault and verifies instruction files, config, gitignore, first sync, and initial commit.

Acceptance:

- A new vault can be opened directly with Claude Code without the user manually explaining Dome's workflow.

### Milestone 2: compiler host spine

- Finish `dome serve` robustness for foreground and background use.
- Add explicit quiet/verbose modes.
- Ensure one adoption is active per branch at a time.
- Coalesce multiple HEAD movements while a run is active.
- Ensure operational work drains on quiet ticks.
- Add `dome status` counts for diagnostics, questions, outbox, quarantine, and failed runs.
- Add `dome sync --json` and `status --json` fixtures that are stable for agent consumption.

Acceptance:

- With `dome serve` running, a user/Claude commit gets adopted automatically and produces a clear status trail.

### Milestone 3: deterministic adopted-state substrate

- Complete `dome.markdown` and `dome.graph` against real vault files.
- Extend shipped `dome.search` beyond FTS/`dome query` into export-context retrieval.
- Keep `dome rebuild` as the explicit projection recovery path from adopted commit.
- Keep stale projection invalidation for processor-version and extension-set changes covered by cache-key drift rebuilds.

Acceptance:

- After commits, `dome query` can find adopted-state snippets and facts with SourceRefs.
- `dome rebuild` can wipe/recreate projection state without touching run ledger/outbox.

### Milestone 4: recovery and questions

- Finish answer durability beyond rebuildable projection state.
- Add first-party recovery answer handlers where human intent is required.
- Add `dome.health` probes:
  - failed/stuck outbox,
  - orphan running rows,
  - quarantined processors,
  - schema skew,
  - AGENTS/CLAUDE managed-section drift,
  - adopted-ref divergence.
- Add question emitters and answer handlers for recoverable cases.
- Keep quarantine visible/resettable through the same question/answer flow; optionally move the backing store from JSON to sqlite if the operational state model needs richer history.

Acceptance:

- A stuck outbox row, orphan run, or quarantined processor is visible and recoverable without opening sqlite manually.

### Milestone 5: daily-note and task loop

- Define minimal markdown task schema compatible with plain Obsidian checkboxes.
- [x] Implement `dome.daily.create-daily`.
- [x] Implement carry-forward of unfinished tasks from the previous daily note.
- [x] Index explicit open checkboxes and `#followup` / `#follow-up` markers
  in daily notes as source-ref-backed facts.
- Implement richer extraction of followups/todos from daily notes or raw
  captures.
- Decide whether task completion writes are direct garden patches or questions when ambiguous.

External prior: Obsidian task plugins show the durable expectation here: users want vault-wide task queries, due/recurring metadata, and carry-forward into daily/weekly notes. See <https://community.obsidian.md/plugins/obsidian-tasks-plugin> and <https://www.obsidianstats.com/plugins/auto-tasks>.

Acceptance:

- A user can talk with Claude about today's work, commit the daily note, and Dome creates/carries forward the next actionable task surface.

### Milestone 6: modelInvoke substrate

- Define the stable `modelInvoke` capability and provider boundary.
- Enforce model allowlists and `maxDailyCostUsd`.
- Ledger token/cost data on every model attempt.
- Validate structured outputs at the boundary.
- Treat model parse/schema failures as nominal processor failures.
- Ensure retries are bounded and idempotent.

Acceptance:

- LLM-capable processors can fail, time out, or exceed budget without corrupting adopted state or hiding cost.

### Milestone 7: LLM garden processors

- Implement `dome.intake.extract-capture` for `inbox/raw/**`.
- Implement task/followup extraction with structured output validation.
- Enforce model allowlists and `maxDailyCostUsd`.
- Ensure all LLM processor failures are ledgered and recoverable.
- Keep all LLM-generated patches behind capability-scoped paths and source refs.

Acceptance:

- Raw captures can become wiki/daily/task updates without blocking adoption.
- Bad model output produces a diagnostic/run error, not a corrupted vault.

### Milestone 8: user-value views

- Implement `dome export-context <topic>`.
- Implement `dome lint` as a report over diagnostics plus additional checks.
- Add `dome today` / `dome prep` if the daily bundle has enough data to render something useful.
- Keep generic `dome run` as a development escape hatch; teach named commands in instructions.

Acceptance:

- Claude/user can ask for a source-backed context packet or a vault cleanup report without manually spelunking projections.

### Milestone 9: v1 release hardening

- Add live harness scenarios matching the acceptance scenario.
- Add fixtures for host-on and host-off workflows.
- Add cost/quarantine/outbox failure tests.
- Add bundle coverage tests so docs/matrices cannot name unshipped processors as shipped.
- Run full `bun test`, `bunx tsc --noEmit`, and `git diff --check`.

Acceptance:

- The system can be used against the author's real vault for a week without manual sqlite edits, lost garden patches, or confusing silent failures.

## Hosted queue runway

Do not build the cloud queue for v1, but keep these design hooks:

- Proposals must remain the only write path.
- Garden patches must already be representable as Proposals.
- Adoption must stay deterministic enough to run in CI/hosted mode.
- Engine-generated commits must carry trailers linking run/proposal/source.
- Operational decisions must be represented as diagnostics/questions, not local imperative commands.

When v1 local mode is solid, hosted-protected mode can add:

- remote proposal refs (`refs/dome/proposals/*`),
- queue refs or synthetic merge-group commits,
- per-proposal engine status,
- push-back of engine patches onto proposal branches,
- conflict/rebase handling,
- auto-merge only after adoption + required checks pass.

That is v1.5. It is important, but it should not distract from making the local Claude Code loop useful first.

## Principle checks

- Prefer autonomous processors over commands the agent must remember.
- Keep host modes interchangeable: one-shot, foreground, background, embedded, hosted.
- Prefer markdown/git's native shape over custom write APIs.
- Prefer small, named CLI commands over a generic agent tool surface.
- Prefer deterministic processors before LLM processors.
- Prefer questions over hidden recovery mutations.
- Prefer one operational recovery channel over per-substrate admin verbs.
- Keep MCP optional until it solves a real harness limitation.
