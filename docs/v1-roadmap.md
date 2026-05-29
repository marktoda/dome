# Dome v1 Roadmap

This is the technical plan of record for the v1 product described in
[[wiki/syntheses/v1-claude-code-vault-plan]]. The product plan explains
why Dome exists and what daily workflow must feel good. This roadmap explains
the implementation order, the shipped ledger, and the acceptance checks.

If the two docs disagree, update both in the same change. Do not add a second
"near-term" plan below this one; add checked or unchecked items to the relevant
milestone instead.

## Product Target

V1 is a local-first Claude Code vault compiler:

```text
Claude/user edits markdown
  -> Claude/user commits through normal git
  -> dome serve or dome sync detects HEAD/adopted drift
  -> adoption processors validate, normalize, and index deterministic state
  -> adopted ref advances only after a clean fixed point
  -> garden processors run follow-on maintenance
  -> status, inspect, doctor, answer, query, and export explain the result
```

The goal is not a bespoke agent write API. Claude Code already has strong file,
grep, shell, and git tools. Dome's job is to make normal committed vault edits
compound into reliable adopted state, projections, daily workflows, and
recovery surfaces.

## Execution Rules

1. **Milestones are the plan.** Work through the milestone ladder below. Use
   small implementation slices, but record them under the milestone they
   advance.
2. **Keep completed work checked.** Do not delete shipped work from this file;
   check it off so the path to v1 stays visible.
3. **Runtime first, commands second.** `serve`, `sync`, and `status` are the
   compiler host surface. User-value commands should read adopted state; they
   should not become a parallel write path.
4. **Recovery before trust.** Daily automation and LLM processors should not
   become v1-critical until diagnostics, questions, outbox failures,
   quarantine, and orphan runs are visible and recoverable.
5. **Extension bundles stay clean.** If a feature cannot be added as a
   processor/effect/capability/projection/view without a backdoor, stop and
   tighten the extension boundary before implementing the feature.
6. **Prefer E2E harness proof.** Unit tests are useful, but milestone
   acceptance should be proven through high-level harness scenarios whenever
   possible.
7. **MCP and hosted queue are runway.** Keep the engine compatible with MCP,
   HTTP/mobile, and a future hosted merge queue, but do not let those surfaces
   block the local Claude Code v1.

## Current State

Shipped:

- [x] Four-concept engine model: Vault, Proposal, Processor, Effect.
- [x] Fixed-point adoption loop and `refs/dome/adopted/<branch>`.
- [x] Garden sub-Proposals and operational work drain.
- [x] Capability broker as the single effect gate.
- [x] Bun.sqlite projection store, run ledger, outbox, and rebuild path.
- [x] Processor runtime with output validation, cancellation, timeouts,
      nominal transient/model errors, and quarantine.
- [x] Commander-based CLI dispatch.
- [x] `dome init`, `dome sync`, `dome serve`, `dome status`, `dome inspect`,
      `dome run`, and `dome rebuild`.
- [x] Deterministic first-party processors:
      `dome.markdown.validate-wikilinks`,
      `dome.markdown.normalize-frontmatter`,
      `dome.markdown.lint-frontmatter`,
      `dome.markdown.broken-images`,
      `dome.markdown.duplicate-detection`,
      `dome.markdown.stale-dates`,
      `dome.markdown.orphan-pages`,
      `dome.graph.links`,
      `dome.graph.tag-index`.
- [x] Page-type schema substrate.
- [x] Diagnostic auto-resolve for changed paths.
- [x] Projection cache-key drift rebuild on processor-version / extension-set
      changes.
- [x] High-level harness coverage for adoption, triggers, effects,
      convergence, lifecycle, CLI surface, capability gates, and projection
      recovery.

Still missing for v1:

- [x] Adopted-state recall: `dome.search` FTS indexing and `dome query`.
- [ ] Durable recovery: `dome answer`, answer-triggered follow-up dispatch,
      and probe-only `dome doctor` are shipped; quarantine reset, outbox
      recovery, orphan-run recovery, and remaining health probes are still
      pending.
- [ ] Daily/task loop: daily creation, carry-forward, followup/todo
      extraction, today/prep views.
- [ ] Productized model boundary: provider injection, cost ledger, budgets,
      structured-output validation, bounded retries.
- [ ] LLM garden/intake processors with provenance and source-backed writes.
- [ ] User-value views: `dome export-context`, useful `dome lint`, and
      daily/task views once data exists.
- [ ] V1 end-to-end acceptance harness and real-vault dogfood run.

## Milestone 0 - Plan and Spec Coherence

Status: shipped; maintain continuously.

Goal: every contributor can tell what v1 must ship, what is optional, and
where each design decision belongs.

Work:

- [x] Use [[wiki/syntheses/v1-claude-code-vault-plan]] as the product
      contract.
- [x] Use this file as the technical roadmap and shipped-status ledger.
- [x] Link both from `docs/index.md`.
- [x] Keep MCP described as optional/additive for v1.
- [ ] Mark aspirational matrices as roadmap/speculative when they name
      unshipped bundles or processors.
- [ ] Keep `docs/wiki/specs/cli.md` aligned with actual command state and
      v1-required placeholders.

Acceptance:

- [x] A contributor can reach the v1 product plan and technical roadmap from
      `docs/index.md`.
- [x] No v1 acceptance path requires MCP.
- [ ] No planning/spec doc claims an unshipped command or bundle is shipped.

## Milestone 1 - Claude Code Boot Path

Status: shipped for initial v1; update when query/recovery commands become
part of default Claude workflow.

Goal: `dome init <vault>` creates a git repo Claude Code can immediately work
in.

Work:

- [x] Write `.dome/config.yaml`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and
      an initial commit.
- [x] Make `CLAUDE.md` delegate to `AGENTS.md`.
- [x] Keep generated instructions short and operational: edit markdown,
      commit meaningful changes, use `serve`/`sync`, inspect health, avoid
      `.dome/state/`.
- [x] Preserve user prose when re-running init.

Acceptance:

- [x] E2E harness scenario for fresh init, generated files, git state, and
      first sync.
- [x] CLI tests assert generated `AGENTS.md` / `CLAUDE.md` content.
- [ ] Release-hardening smoke against `docs/` or `~/vaults/work` where safe.

## Milestone 2 - Compiler Host Spine

Status: partially shipped.

Goal: `dome serve` is a boring foreground compiler host, and `dome sync` is
the same flow in one-shot form.

Work:

- [x] Share drift detection, runtime open, adoption, garden, and operational
      drain between `serve`, `sync`, and the harness.
- [x] Drain operational work even when HEAD/adopted are already in sync.
- [x] Preserve the pretty text `status` dashboard.
- [x] Keep `sync --json` available for agent consumption.
- [ ] Add host-on `serve` E2E coverage: commit while `serve` runs, adopted ref
      catches up, status reports healthy.
- [ ] Stabilize `sync --json` and `status --json` fixture schemas.
- [ ] Coalesce branch movement while adoption is active.
- [ ] Ensure only one adoption runs per branch at a time.
- [ ] Add explicit quiet/verbose output modes and decide whether
      `serve --exclusive` belongs in v1.

Acceptance:

- [ ] Host-on E2E scenario proves `serve` adopts branch movement.
- [x] Host-off E2E path is covered by `sync` harness scenarios.
- [x] In-sync operational-drain path is covered by harness/CLI scenarios.
- [ ] CLI fixture tests cover status/sync text and JSON schemas.

## Milestone 3 - Deterministic Adopted-State Substrate

Status: active.

Goal: adopted state is queryable, rebuildable, and deterministic before LLM
processors enter the write path.

Work:

- [x] Ship `dome.markdown` hygiene/diagnostic processors against real vault
      files.
- [x] Ship `dome.graph.links` and `dome.graph.tag-index` fact emitters.
- [x] Ship page-type schema validation as a deterministic enhancement.
- [x] Ship `dome rebuild` as explicit projection recovery.
- [x] Detect processor-version / extension-set cache-key drift.
- [x] Rebuild projection rows from adopted state before stale rows are
      consumed.
- [x] Decide the clean FTS extension boundary before implementation:
      first-class effect/capability, engine-owned projection derivation, or
      another principled route. Do not let `dome.search` write SQLite
      directly.
- [x] Implement `dome.search` FTS indexing over adopted markdown.
- [x] Implement first `dome query <text>` over FTS snippets and facts, with
      SourceRefs and no LLM summary.
- [x] Make graph facts and tag facts queryable through the same adopted-state
      view path.

Acceptance:

- [x] Wipe projection rows, run `dome rebuild --json`, facts/diagnostics rows
      return without touching ledger/outbox.
- [x] Bump a test processor version and stale projection rows do not survive
      silently.
- [x] Commit markdown, sync, query by text returns adopted-state snippets and
      SourceRefs.
- [x] Query returns graph/tag facts relevant to the search term or filters.

## Milestone 4 - Recovery and Questions

Status: partially shipped.

Goal: a stuck Dome system is recoverable through one understandable
operational surface.

Work:

- [x] Implement `dome answer <question-id> [value]` to print questions,
      validate options, and persist answers by stable question row id.
- [x] Add answer-triggered processor dispatch through
      normal processor/effect semantics.
- [x] Move answer records out of rebuildable projection state into
      `answers.db` and rehydrate answered question rows during projection
      rebuild.
- [x] Make answer-handler dispatch retryable after partial failure by
      keeping handler status in `answers.db` and re-dispatching unanswered
      handler work when `dome answer` is re-run.
- [x] Implement probe-only health checks for failed outbox rows, orphan
      running rows, and quarantined processors.
- [x] Add health probes for projection cache-key skew, instruction drift,
      adopted-ref divergence, and stuck-pending outbox rows.
- [ ] Add non-destructive reporting for operational DB schema mismatches
      before any unrebuildable state is refused or wiped.
- [x] Make `dome doctor` render health findings, not a grab bag of admin
      operations.
- [ ] Move quarantine into durable operational state or provide inspect/reset
      through the same question/answer flow.
- [ ] Route outbox retry/abandon through questions where human intent is
      required.

Acceptance:

- [x] Duplicate-detection emits a question; `dome answer` records the answer.
- [x] Answering a question triggers follow-up processor behavior.
- [ ] Forced outbox failure is visible in status/doctor and recoverable.
- [ ] Quarantined processor is visible and resettable without direct sqlite or
      JSON edits.
- [x] Orphan run is detected by doctor.

## Milestone 5 - Daily Note and Task Loop

Status: missing.

Goal: the user's stated daily workflow works without hand-maintained glue.

Work:

- [ ] Define a minimal task representation compatible with plain markdown
      checkboxes and Obsidian expectations.
- [ ] Implement `dome.daily.create-daily`.
- [ ] Implement carry-forward of unfinished tasks from the previous daily
      note.
- [ ] Implement deterministic followup/todo extraction from daily notes where
      possible.
- [ ] Ask questions for ambiguous writes instead of silently guessing.
- [ ] Add `dome today` and `dome prep` only once they have useful data to
      render.

Acceptance:

- [ ] Yesterday has unfinished tasks; today's daily note is created with
      carried-forward tasks.
- [ ] Daily/capture text yields source-ref-backed followups.
- [ ] Ambiguous task extraction asks a question instead of mutating silently.
- [ ] Real-vault dogfood against `~/vaults/work` or `docs/`.

## Milestone 6 - modelInvoke Substrate

Status: partially proven by fixtures; not productized.

Goal: LLM processors can run without corrupting state, hiding costs, or
creating retry chaos.

Work:

- [ ] Define the stable `modelInvoke` provider boundary. Prefer a maintained
      library such as AI SDK if it keeps the boundary simpler than a
      hand-rolled client.
- [ ] Enforce model allowlists and per-bundle daily cost budgets.
- [ ] Ledger token/cost data on every model attempt.
- [ ] Validate structured outputs at the boundary.
- [ ] Treat model parse/schema failures as nominal processor failures.
- [ ] Ensure retries are bounded and idempotent.
- [ ] Keep LLM write effects capability-scoped and SourceRef-backed.

Acceptance:

- [ ] Model processor succeeds and records cost.
- [ ] Malformed model output becomes a diagnostic/run failure, not a patch.
- [ ] Cost budget denial is visible and recoverable.
- [ ] Timeout/cancellation does not leave orphan running rows.

## Milestone 7 - LLM Garden and Intake

Status: missing.

Goal: captures become useful vault material with provenance.

Work:

- [ ] Implement `dome.intake.extract-capture` for the final v1 inbox/raw
      path.
- [ ] Extract candidate entities, tasks, decisions, and source quotes.
- [ ] File processed captures into durable source pages or owned generated
      regions.
- [ ] Emit facts and questions where confidence is low.
- [ ] Implement first synthesis processor only after intake has provenance and
      budget gates.

Acceptance:

- [ ] Raw capture enters inbox; sync/garden extracts tasks/facts and files
      source material.
- [ ] Bad model output leaves the capture intact and emits a recoverable
      diagnostic.
- [ ] Processor cannot mutate outside capability-scoped paths.

## Milestone 8 - User-Value Views

Status: mostly missing.

Goal: user and Claude can ask for useful views without spelunking sqlite or
remembering internal processors.

Work:

- [ ] Implement `dome export-context <topic>` as a source-backed markdown
      packet.
- [ ] Implement `dome lint` as a report over diagnostics plus deterministic
      checks.
- [ ] Implement `dome today` / `dome prep` once daily/task data is strong
      enough.
- [ ] Keep `dome run` as a dev escape hatch, not the primary user-facing
      command family.

Acceptance:

- [ ] Export-context returns paths, snippets, facts, and SourceRefs for a
      topic.
- [ ] Lint report is stable and exits nonzero only on defined severity
      thresholds.
- [ ] Today/prep views render useful daily/task data.

## Milestone 9 - V1 Release Hardening

Status: missing.

Goal: Dome can run against a real daily vault for a week without manual state
edits, lost garden patches, or silent processor failure.

Work:

- [ ] Add one top-level acceptance scenario matching the Claude Code vault
      plan end to end.
- [ ] Add host-on and host-off live harness fixtures.
- [ ] Add bundle coverage tests so docs/matrices cannot claim unshipped
      processors are shipped.
- [ ] Add status/doctor/query/export JSON fixtures.
- [ ] Add docs for the foreground compiler workflow and recovery loop.
- [ ] Dogfood against `docs/` and `~/vaults/work`.

Acceptance:

- [ ] `bun test`
- [ ] `bunx tsc --noEmit`
- [ ] `git diff --check`
- [ ] `bin/dome status --vault docs`
- [ ] Real-vault smoke test with no manual `.dome/state` edits.

## V1 Bundle Cut

Required for daily value:

| Bundle | Status | V1 responsibility |
|---|---|---|
| `dome.markdown` | partially shipped | deterministic markdown hygiene, wikilink/image/frontmatter diagnostics, page schemas |
| `dome.graph` | partially shipped | wikilink/tag/task/entity facts for recall and daily workflows |
| `dome.search` | partially shipped | FTS indexing, adopted-state query; export-context retrieval remains |
| `dome.health` | partially shipped | doctor probes and recovery questions; probe-only CLI exists, answer handlers missing |
| `dome.daily` | missing | daily creation, task carry-forward, today/prep views |
| `dome.intake` | missing | capture extraction, task/entity/decision facts, questions |

Optional or conditional:

| Bundle | Recommendation |
|---|---|
| `dome.lint` | Ship as a named report only if it adds concrete cleanup value beyond background diagnostics. |
| `dome.index` | Build only if human navigation still needs generated `index.md` after search/query works. |
| `dome.log` | Defer unless humans actually read markdown engine history; the run ledger already records engine events. |
| `dome.migrate` | Ship when schema/version churn requires explicit user-facing migration. |
| `dome.people` / `dome.synthesis` | Post-substrate LLM bundles; do not block deterministic v1. |

## Historical Phase Ledger

Old phase numbers are retained only for git archaeology:

- [x] Phase 11 shipped the commit-watcher daemon, init polish, and
      `dome.markdown.validate-wikilinks`.
- [x] Phase 12 shipped applyPatch substrate and
      `dome.markdown.normalize-frontmatter`.
- [x] Phase 12c fixed closure-commit / branch advancement behavior for
      patch-emitting adoption.
- [x] Phase 13a shipped lint-frontmatter, graph links, orphan-pages,
      `dome run`, and `ctx.projection`.
- [x] Phase 13b shipped tag-index, broken-images, duplicate-detection,
      stale-dates, and `ctx.snapshot.getFileInfo`.
- [x] Phase 13c shipped page-type schemas.
- [x] Phase 14 shipped diagnostic auto-resolve, `dome rebuild`, and
      cache-key drift rebuild on processor-version / extension-set changes.

Future work should use milestone names, not old phase numbers.

## Open Polish Items

Fold these into nearby milestone work when they are on-path:

- `gray-matter` date coercion: unquoted ISO dates parse to JS `Date` and can
  reserialize noisily.
- `serve --exclusive`: PID-file or lock so a second host does not race the
  first.
- Per-processor verbose logging:
  `dome serve --verbose --filter-processor dome.markdown.*`.
- `status --json`: add per-processor recent-run summary once the status schema
  is stable.
- SQLite foreign keys: enable `PRAGMA foreign_keys=ON` where applicable.
- Bundle lockstep tests: assert shipped bundle manifests, capabilities, and
  docs/matrices agree.

## V1 Exit Criteria

V1 is ready when the Claude Code acceptance scenario works against a real
vault:

1. `dome init ~/vaults/work` creates the repo, config, orientation files,
   gitignore, and initial commit.
2. The user starts `dome serve` or runs `dome sync`.
3. Claude Code opens the vault, reads `CLAUDE.md`, edits markdown, and
   commits.
4. Dome adopts the commit, advances the adopted ref, updates projections, and
   runs garden work.
5. Daily/task processors create or update the user's daily working surface.
6. Query/export surfaces retrieve adopted-state evidence with SourceRefs.
7. Questions, outbox failures, quarantine, and orphan runs are visible and
   recoverable through status/inspect/doctor/answer.
8. The system can be dogfooded for a week without direct sqlite/JSON state
   edits or unexplained stuck state.
