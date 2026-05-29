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
- [x] Bun.sqlite projection store, durable answers store, run ledger, outbox,
      and rebuild path.
- [x] Processor runtime with output validation, cancellation, timeouts,
      nominal transient/model errors, and quarantine.
- [x] Commander-based CLI dispatch.
- [x] `dome init`, `dome sync`, `dome serve`, `dome status`, `dome inspect`,
      `dome doctor`, `dome answer`, `dome query`, `dome lint`,
      `dome export-context`, `dome today`, `dome prep`, `dome agenda`,
      `dome run`, and `dome rebuild`.
- [x] Shipped first-party bundle processors:
      `dome.markdown` (7 processors),
      `dome.graph` (2),
      `dome.search` (3),
      `dome.health` (6),
      `dome.daily` (6),
      `dome.lint` (1), and
      `dome.intake` (6).
- [x] Page-type schema substrate.
- [x] Diagnostic auto-resolve for changed paths.
- [x] Page-subject graph/tag fact replacement for changed and deleted paths.
- [x] Projection cache-key drift rebuild on processor-version / extension-set
      changes.
- [x] High-level harness coverage for adoption, triggers, effects,
      convergence, lifecycle, CLI surface, capability gates, and projection
      recovery.

V1 capability ledger:

- [x] Adopted-state recall: `dome.search` FTS indexing and `dome query`.
- [x] Durable recovery: `dome answer`, answer-triggered follow-up dispatch,
      probe-only `dome doctor`, and first-party outbox retry/abandon
      plus quarantine reset and orphan-run recovery are shipped.
- [x] Daily/task loop implementation: daily creation, carry-forward,
      deterministic daily task/followup fact indexing, `today` / `prep` /
      `agenda` views, first raw inbox capture extraction, low-confidence
      answer handling, and source-backed per-capture and cross-capture
      synthesis are shipped.
- [x] Productized model boundary: provider injection, model allowlists,
      structured-output validation, nominal model failures, and run-local cost
      ledgering plus daily budget enforcement are shipped; command provider
      packaging gives vaults a production path without SDK vendor dependencies.
      Maintained-library adapters such as AI SDK or Anthropic SDK wrappers are
      optional provider packages, not core SDK dependencies.
- [x] LLM garden/intake processors with provenance and source-backed writes:
      first `dome.intake.extract-capture` slice, low-confidence capture
      questions/answers, confidence-carrying intake fact namespaces, and
      stale-inbox diagnostics shipped; source-backed capture synthesis and
      cross-capture rollup processors shipped.
- [x] User-value views: `dome today`, `dome prep`, `dome agenda`,
      `dome lint`, and
      `dome export-context` are shipped.
- [x] V1 end-to-end acceptance harness.
- [x] Initial real-vault smoke against `docs/` and `~/vaults/work`.
- [ ] Week-long daily workflow dogfood without manual `.dome/state` edits.

## Active Release Gate

V1 is implementation-complete enough for release only after the real daily
management vault survives the following audited soak. This is the remaining
release gate; harness green is necessary but not sufficient.

Target vault and host:

- Vault: `~/vaults/work`.
- Host: foreground `dome serve --vault ~/vaults/work` for normal sessions.
- Catch-up fallback: `dome sync --vault ~/vaults/work --json` when the host was
  intentionally off.
- Model path: a configured command model provider for `dome.intake`, with the
  same provider shape exercised by the V1 harness.

Daily soak script, repeated for seven working days:

- [ ] Start or verify `dome serve`.
- [ ] Open Claude Code in `~/vaults/work`; rely on vault `CLAUDE.md` /
      `AGENTS.md`, native file tools, and normal git commits.
- [ ] Capture at least one management update in markdown: report follow-up,
      project decision, idea, meeting note, or raw inbox capture.
- [ ] Commit the vault change through git.
- [ ] Let `dome serve` adopt it, or run `dome sync --json` to block.
- [ ] Review `dome status --json`; record whether there are diagnostics,
      questions, failed outbox rows, quarantines, pending runs, or pending
      commits.
- [ ] Use at least one user-value view for real work: `dome today`,
      `dome prep`, `dome agenda <person-or-topic>`, `dome query <topic>`, or
      `dome export-context <topic>`.
- [ ] Resolve any open `dome.health` or intake questions through
      `dome inspect questions` and `dome answer`, not by editing
      `.dome/state` directly.

Required evidence:

- A dated soak note in the vault for each day with the commands run, status
  summary, any open questions/diagnostics, and whether manual state edits were
  needed.
- `dome status --json` evidence before stopping each session.
- For any stuck state, `dome doctor --json` plus the recovery command or code
  fix that resolved it.

Release-blocking failures:

- Any manual sqlite/JSON edit under `.dome/state`.
- A lost or overwritten human/Claude markdown edit.
- An engine-created patch that does not materialize into the working tree.
- A pending run, failed outbox row, quarantine, or open question that cannot be
  understood and resolved through `status` / `doctor` / `inspect` / `answer`.
- A model/intake failure mode that loses the raw capture or commits
  ungrounded output without SourceRefs.
- A repeated command or status output that is confusing enough that Claude Code
  would plausibly take the wrong next action.

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
- [x] Mark aspirational matrices as roadmap/speculative when they name
      unshipped bundles or processors.
- [x] Keep `docs/wiki/specs/cli.md` aligned with actual command state and
      v1-required placeholders.

Acceptance:

- [x] A contributor can reach the v1 product plan and technical roadmap from
      `docs/index.md`.
- [x] No v1 acceptance path requires MCP.
- [x] No planning/spec doc claims an unshipped command or bundle is shipped.

## Milestone 1 - Claude Code Boot Path

Status: shipped for initial v1; update when query/recovery commands become
part of default Claude workflow.

Goal: `dome init <vault>` creates a git repo Claude Code can immediately work
in.

Work:

- [x] Write `.dome/config.yaml`, `.gitignore`, `AGENTS.md`, `CLAUDE.md`, and
      an initial commit.
- [x] Create the day-one local directory scaffold: `wiki/`, `notes/`,
      `inbox/raw/`, `inbox/processed/`, and `.dome/state/`.
- [x] Make `CLAUDE.md` delegate to `AGENTS.md`.
- [x] Keep generated instructions short and operational: edit markdown,
      commit meaningful changes, use `serve`/`sync`, inspect health, avoid
      `.dome/state/`.
- [x] Preserve user prose when re-running init.
- [x] Add explicit `dome init --refresh-config` recovery for old first-party
      configs with missing default bundle stanzas or missing default grant
      keys, without clobbering custom grant values or re-enabling explicitly
      disabled bundles.
- [x] Add explicit `dome init --refresh-instructions` recovery for old
      AGENTS/CLAUDE orientation shims, preserving existing vault guidance.

Acceptance:

- [x] E2E harness scenario for fresh init, generated files, git state, and
      first sync.
- [x] CLI tests assert generated `AGENTS.md` / `CLAUDE.md` content.
- [x] E2E harness scenario for refreshing stale first-party grant keys and
      clearing doctor grant-gap findings.
- [x] E2E harness scenario for refreshing stale AGENTS/CLAUDE shims and
      clearing doctor instruction-drift findings.
- [x] Release-hardening smoke against `docs/` or `~/vaults/work` where safe.

## Milestone 2 - Compiler Host Spine

Status: shipped for v1; maintain through release hardening.

Goal: `dome serve` is a boring foreground compiler host, and `dome sync` is
the same flow in one-shot form.

Work:

- [x] Share drift detection, runtime open, adoption, garden, and operational
      drain between `serve`, `sync`, and the harness.
- [x] Move background compiler-host orchestration out of CLI glue into the
      engine layer (`src/engine/compiler-host.ts`).
- [x] Add a single compiler-host tick result boundary for `serve`, `sync`, and
      the harness, including the final adopted ref after sub-Proposals.
- [x] Thread the latest adopted cursor through garden cascades and operational
      processors so multiple patch-producing units in one tick chain on the
      current ref instead of forking from a stale starting commit.
- [x] Drain operational work even when HEAD/adopted are already in sync.
- [x] Preserve the pretty text `status` dashboard.
- [x] Keep `sync --json` available for agent consumption.
- [x] Add host-on `serve` E2E coverage: commit while `serve` runs, adopted ref
      catches up, status reports healthy.
- [x] Stabilize `sync --json` and `status --json` fixture schemas.
- [x] Coalesce branch movement while adoption is active.
- [x] Ensure only one compiler-host tick runs per branch at a time.
- [x] Refresh drift inside the branch lock so one-shot sync cannot adopt a
      stale observed HEAD while newer committed work is already present.
- [x] Refuse adopted-ref divergence at the shared drift boundary before
      constructing a Proposal, so rewritten branch histories cannot enter the
      adoption or branch-materialization path.
- [x] Materialize engine-created branch commits into the checked-out working
      tree for changed paths, while blocking before adoption if that would
      overwrite uncommitted local edits.
- [x] Add explicit verbose output mode.
- [x] Decide whether `serve --exclusive` belongs in v1: no separate flag for
      v1; branch-level compiler-host locking is always on.
- [x] Add explicit quiet output mode.
- [x] Surface foreground `dome serve` liveness in `dome status` via a
      host-owned heartbeat file, reporting `running`, `stale`, or `off`
      without using the per-tick compiler-host lock as a daemon marker.

Acceptance:

- [x] Host-on E2E scenario proves `serve` adopts branch movement.
- [x] Host-off E2E path is covered by `sync` harness scenarios.
- [x] In-sync operational-drain path is covered by harness/CLI scenarios.
- [x] CLI fixture tests cover status/sync text and JSON schemas.

## Milestone 3 - Deterministic Adopted-State Substrate

Status: shipped for deterministic v1; maintain through release hardening.

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
- [x] Bootstrap projection rows on the first sync of an existing vault, even
      when the adopted ref starts uninitialized and the commit range is empty.
- [x] Keep git tree reads scoped to the vault subtree when a Dome vault is
      dogfooded inside a larger git repository.
- [x] Rebuild projection rows from explicitly deterministic, projection-safe
      garden processors without re-running patches, jobs, operational
      recovery, external actions, or model calls.
- [x] Decide the clean FTS extension boundary before implementation:
      first-class effect/capability, engine-owned projection derivation, or
      another principled route. Do not let `dome.search` write SQLite
      directly.
- [x] Implement `dome.search` FTS indexing over adopted markdown.
- [x] Implement first `dome query <text>` over FTS snippets and facts, with
      SourceRefs and no LLM summary.
- [x] Make graph facts and tag facts queryable through the same adopted-state
      view path.
- [x] Replace graph/tag page facts on edit/delete instead of accumulating stale
      projection rows until a full rebuild.
- [x] Rebuild projections when candidate-bound projection-global config changes,
      starting with `.dome/page-types.yaml`, so schema diagnostics stay correct
      even for pages outside the changed-path set.

Acceptance:

- [x] Wipe projection rows, run `dome rebuild --json`, facts/diagnostics rows
      return without touching ledger/outbox.
- [x] Bump a test processor version and stale projection rows do not survive
      silently.
- [x] Commit markdown, sync, query by text returns adopted-state snippets and
      SourceRefs.
- [x] Query returns graph/tag facts relevant to the search term or filters.
- [x] Editing or deleting a page removes stale graph/tag facts for that page
      through normal sync, without requiring `dome rebuild`.
- [x] `dome rebuild --json` restores projection rows produced by an eligible
      garden-phase processor, not only adoption-phase processors.

## Milestone 4 - Recovery and Questions

Status: shipped for first-party recovery loops; maintain through release hardening.

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
- [x] Move durable answer-handler dispatch policy out of CLI glue and into
      the engine question-answering boundary.
- [x] Implement probe-only health checks for failed outbox rows, orphan
      running rows, and quarantined processors.
- [x] Add health probes for projection cache-key skew, instruction drift,
      adopted-ref divergence, and stuck-pending outbox rows.
- [x] Add non-destructive reporting for operational DB schema mismatches
      before any unrebuildable state is refused or wiped.
- [x] Add read-only `dome doctor` reporting for enabled processors whose
      declared capability kinds are missing from the vault's effective grants.
- [x] Make `dome doctor` render health findings, not a grab bag of admin
      operations.
- [x] Move quarantine into durable operational state or provide inspect/reset
      through the same question/answer flow.
- [x] Add `OutboxRecoveryEffect` + `outbox.recover` so answer handlers can
      retry/abandon failed outbox rows without direct DB access.
- [x] Ship first-party `dome.health` outbox recovery question emitters and
      answer handlers.
- [x] Add `QuarantineRecoveryEffect` + `quarantine.read` /
      `quarantine.recover` so health answer handlers can reset quarantined
      processor triggers without direct state-file access.
- [x] Ship first-party `dome.health` quarantine recovery question emitters and
      answer handlers.
- [x] Add `RunRecoveryEffect` + `run.read` / `run.recover` so health answer
      handlers can fail orphaned running rows without direct ledger access.
- [x] Ship first-party `dome.health` orphan-run recovery question emitters and
      answer handlers.
- [x] Bind privileged recovery answer handlers to the originating question
      processor plus the idempotency-key prefix, and surface stale
      orphan-run recovery answers as diagnostics rather than silent no-ops.

Acceptance:

- [x] Duplicate-detection emits a question; `dome answer` records the answer.
- [x] Answering a question triggers follow-up processor behavior.
- [x] Forced outbox failure is visible in status/doctor and recoverable
      through shipped `dome.health` questions, not just the substrate fixture.
- [x] Quarantined processor is visible and resettable without direct sqlite or
      JSON edits.
- [x] Orphan run is detected by doctor.
- [x] Orphan run is recoverable through shipped `dome.health` questions, not
      direct sqlite edits.
- [x] Old or hand-edited configs with enabled processors but missing grant
      kinds are visible in doctor before the next sync blocks on capability
      enforcement.

## Milestone 5 - Daily Note and Task Loop

Status: shipped for v1; week-long management-workflow soak remains in
Milestone 9.

Goal: the user's stated daily workflow works without hand-maintained glue.

Work:

- [x] Define a minimal task representation compatible with plain markdown
      checkboxes and Obsidian expectations: v1 treats open `- [ ]` / `* [ ]`
      lines in daily notes as tasks, preserves the checkbox line as markdown,
      and preserves any existing carried-forward origin marker.
- [x] Implement `dome.daily.create-daily`.
- [x] Implement carry-forward of unfinished tasks from the previous daily
      note.
- [x] Index explicit open daily checkboxes as source-ref-backed
      `dome.daily.open_task` facts, and explicit `#followup` / `#follow-up`
      checkboxes as `dome.daily.followup` facts.
- [x] Decide whether v1 needs stable task identities, or whether page-scoped
      daily task observations are enough until a richer task model lands.
- [x] Implement deterministic followup/todo extraction from daily notes where
      possible beyond explicit checkbox markers.
- [x] Extend deterministic task/followup extraction to non-daily wiki pages
      without widening `dome.daily`'s auto-patch authority.
- [x] Ask questions for ambiguous writes instead of silently guessing.
- [x] Add `dome today` once deterministic task/followup data is useful enough
      to render.
- [x] Add `dome prep` once there is enough planning context to render.
- [x] Add `dome agenda` for source-backed people/topic prep.

Decision:

- [x] V1 task identity is page/source-ref scoped. Stable cross-page task ids
      are deferred until there is a richer task model with user-visible task
      lifecycle semantics.

Acceptance:

- [x] Yesterday has unfinished tasks; today's daily note is created with
      carried-forward tasks.
- [x] Explicit daily checkbox tasks and followup markers yield
      source-ref-backed facts.
- [x] Daily note TODO/follow-up directive text yields source-ref-backed tasks
      and followups.
- [x] Ambiguous task extraction asks a question instead of mutating silently.
- [x] Capture text outside daily notes yields source-ref-backed followups.
- [x] `dome today` renders source-backed daily/task/followup/question data.
- [x] `dome agenda <person>` renders source-backed matching tasks, followups,
      questions, and adopted-state context snippets.
- [x] Initial real-vault smoke opens existing `docs/` and `~/vaults/work`
      vaults without manual state edits; week-long management-workflow soak
      remains in Milestone 9.

## Milestone 6 - modelInvoke Substrate

Status: shipped for v1; keep vendor-specific adapters outside the SDK core.

Goal: LLM processors can run without corrupting state, hiding costs, or
creating retry chaos.

Work:

- [x] Define the stable `modelInvoke` provider boundary. Core ships a
      provider-neutral function contract plus command-provider adapter; prefer
      maintained library adapters such as AI SDK outside the core package when
      they simplify real provider integration.
- [x] Enforce per-bundle daily cost budgets.
- [x] Enforce effective model allowlists before provider calls.
- [x] Ledger provider-reported run-local cost.
- [x] Validate structured outputs at the boundary.
- [x] Treat model parse/schema failures as nominal processor failures.
- [x] Ensure structured-output retries are bounded.
- [x] Retry one retryable provider failure inside `modelInvoke` while leaving
      model-call timeouts single-attempt so long LLM calls do not silently
      double their worst-case duration.
- [x] Keep LLM write effects capability-scoped and SourceRef-backed.
- [x] Package a production provider path; vaults can configure a command
      provider and the CLI/harness path exercises it without runtime injection.
- [x] Report a read-only doctor preflight when model-capable processors are
      enabled and granted `model.invoke` but no provider is configured for the
      CLI/host runtime.

Acceptance:

- [x] Model processor succeeds and records cost.
- [x] Malformed model output becomes a diagnostic/run failure, not a patch.
- [x] Cost budget denial is visible and recoverable.
- [x] Timeout/cancellation does not leave orphan running rows.
- [x] Model-generated patches without SourceRefs fail before routing.
- [x] `dome doctor --json` warns before a configured model-capable bundle is
      run without a provider, and the V1 acceptance harness exercises the
      production command-provider path.

## Milestone 7 - LLM Garden and Intake

Status: shipped for v1; richer long-horizon synthesis is deferred.

Goal: captures become useful vault material with provenance.

Work:

- [x] Implement `dome.intake.extract-capture` for the final v1
      `inbox/raw/*.md` path.
- [x] Extract candidate entities, tasks, decisions, and source quotes into a
      generated capture page.
- [x] File processed captures into durable archive pages and owned generated
      regions.
- [x] Emit low-confidence capture questions instead of committing uncertain
      model items as tasks, followups, decisions, or entities.
- [x] Add answer handling for low-confidence capture questions.
- [x] Emit richer intake fact namespaces with confidence.
- [x] Emit stale-inbox diagnostics for lingering unprocessed inbox files.
- [x] Implement first synthesis processor only after intake has provenance and
      budget gates.
- [x] Implement first cross-capture synthesis rollup over recent generated
      captures through the same model budget and source-ref guardrails.

Acceptance:

- [x] Raw capture enters inbox; sync/garden extracts tasks/facts and files
      source material.
- [x] Bad model output leaves the capture intact and emits a recoverable
      diagnostic.
- [x] Processor cannot mutate outside capability-scoped paths.
- [x] Low-confidence extracted items are not written into generated capture
      pages until the user answers a question.
- [x] Answering `track` for a low-confidence item patches the generated
      capture page through a garden sub-Proposal and downstream task facts.
- [x] Generated capture pages carry tracked item confidence in frontmatter,
      and deterministic adoption indexing emits `dome.intake.*` facts that
      survive projection rebuild.
- [x] Stale files under intake inbox buckets emit `inbox.stale` diagnostics
      and resolve when the file is removed or refreshed.
- [x] Generated capture pages synthesize into source-linked
      `wiki/syntheses/intake-*.md` pages through the same model budget and
      source-ref guardrails.
- [x] Recent generated capture pages synthesize into a source-linked
      `wiki/syntheses/intake-rollup.md` page through the same model budget
      and source-ref guardrails.

## Milestone 8 - User-Value Views

Status: shipped for deterministic v1 views; future aliases can be added as
needed.

Goal: user and Claude can ask for useful views without spelunking sqlite or
remembering internal processors.

Work:

- [x] Implement `dome export-context <topic>` as a source-backed markdown
      packet.
- [x] Implement `dome lint` as a report over diagnostics plus deterministic
      checks.
- [x] Implement `dome today` once daily/task data is strong enough.
- [x] Implement `dome prep` once planning context is strong enough.
- [x] Implement `dome agenda` once people/topic prep has useful source-backed
      data.
- [x] Keep `dome run` as a dev escape hatch, not the primary user-facing
      command family.

Acceptance:

- [x] Export-context returns paths, snippets, facts, and SourceRefs for a
      topic.
- [x] Lint report is stable and exits nonzero only on defined severity
      thresholds.
- [x] Today view renders useful daily/task data.
- [x] Prep view renders useful planning data.
- [x] Agenda view renders useful people/topic prep data.

## Milestone 9 - V1 Release Hardening

Status: release-gate harness shipped; week-long real-vault soak remains.

Goal: Dome can run against a real daily vault for a week without manual state
edits, lost garden patches, or silent processor failure.

Work:

- [x] Add one top-level acceptance scenario matching the Claude Code vault
      plan end to end.
- [x] Add host-off `sync` and host-on compiler-tick harness fixtures.
      `serve` daemon pickup remains covered by the lower-level CLI E2E suite.
- [x] Add daemon-mode release-hardening coverage where `dome serve` runs the
      intake management workflow through the configured command model provider,
      materializes generated capture/archive files, and exits with clean
      operational status.
- [x] Add a top-level recovery gauntlet where status, doctor, inspect,
      first-party health questions, and `dome answer` recover failed outbox,
      quarantine, and orphan-run state through the normal operational surface.
- [x] Add bundle coverage tests so docs/matrices cannot claim unshipped
      processors are shipped.
- [x] Add status/doctor/query/export JSON fixtures.
- [x] Add docs for the foreground compiler workflow and recovery loop.
- [x] Dogfood `dome sync --vault docs --json`; this uncovered and fixed
      branch/worktree materialization for engine-created commits.
- [x] Dogfood `dome doctor --vault ~/vaults/work --json`; this uncovered and
      fixed missing-grant drift reporting for old first-party config.
- [x] Narrow unsupported scheduled view processors out of the v1 manifest
      contract; scheduled work is garden-only until a scheduled view delivery
      surface exists.
- [x] Add reproducible `bun run v1:smoke` real-vault smoke gate for `docs/`
      and `~/vaults/work`, with mutation limited to explicit `--sync-docs`.
- [x] Dogfood against `docs/` and `~/vaults/work`.
- [x] Make runtime close drain processor work before SQLite handles close:
      garden/view dispatch is cancelled through the executor signal, adoption
      work is awaited for atomicity, and terminal run rows are written before
      handle release.
- [x] Reject PatchEffect file/directory path collisions at the tree rewrite
      boundary instead of producing duplicate or invalid git tree entries.
- [x] Bound outbox handler execution with per-attempt timeouts and an
      engine-owned cancellation signal, while preserving pending rows and retry
      budget on explicit dispatch cancellation.
- [x] Thread foreground host shutdown cancellation into operational outbox
      dispatch so `dome serve` can stop retryable external work promptly
      without marking rows failed or burning attempts.
- [ ] Use Dome for one week of real daily management workflow without manual
      sqlite/JSON state edits, lost garden patches, or unexplained stuck
      state.

Acceptance:

- [x] `bun test`
- [x] `bunx tsc --noEmit`
- [x] `git diff --check`
- [x] `bin/dome status --vault docs`
- [x] Real-vault smoke test with no manual `.dome/state` edits.
- [ ] Week-long real-vault soak exits without manual `.dome/state` edits or
      unexplained stuck state.

## V1 Remaining Gate

The only remaining V1 release gate is real use: run Dome against the daily
management vault for one week, with `dome serve` or regular `dome sync`, and
fix any issue that requires manual sqlite/JSON edits, loses garden patches,
leaves unexplained stuck state, or makes recovery confusing.

## V1 Bundle Cut

Required for daily value:

| Bundle | Status | V1 responsibility |
|---|---|---|
| `dome.markdown` | v1 shipped | deterministic markdown hygiene, wikilink/image/frontmatter diagnostics, page schemas |
| `dome.graph` | v1 shipped | wikilink and tag facts for recall; task facts live in `dome.daily`, intake entities in `dome.intake` |
| `dome.search` | v1 shipped | FTS indexing, adopted-state query, and source-backed export-context retrieval; embeddings remain post-v1 |
| `dome.health` | v1 shipped | doctor probes; probe-only CLI; failed-outbox retry/abandon, quarantine-reset, and orphan-run recovery question emitters and answer handlers |
| `dome.daily` | v1 shipped | daily creation, task carry-forward, deterministic wiki-page task/followup fact indexing, ambiguity questions, `dome today`, `dome prep`, and `dome agenda`; generated intake captures feed the same task index |
| `dome.intake` | v1 shipped | raw `inbox/raw/*.md` capture extraction, generated capture pages, processed archives, model cost/provenance gates, low-confidence questions/answers, downstream task/followup facts, confidence-carrying `dome.intake.*` fact namespaces, stale-inbox diagnostics, source-backed per-capture synthesis, and source-backed recent-capture rollup; richer long-horizon synthesis remains post-v1 |

Optional or conditional:

| Bundle | Recommendation |
|---|---|
| `dome.lint` | Shipped as an adopted-state report over diagnostics plus deterministic lint checks; future review/apply flow remains optional. |
| `dome.index` | Build only if human navigation still needs generated `index.md` after search/query works. |
| `dome.log` | Defer unless humans actually read markdown engine history; the run ledger already records engine events. |
| `dome.migrate` | Ship when schema/version churn requires explicit user-facing migration. |
| `dome.people` / `dome.synthesis` | Post-substrate LLM bundles; do not block deterministic v1. |

## Post-v1 / V1.5 Runway

These are explicitly not V1 blockers, but the V1 architecture should keep
them natural:

- hosted queue: remote proposal refs, synthetic merge candidates, engine
  patches pushed onto proposal branches, conflict routing, and auto-merge only
  after adoption plus required checks pass;
- provider adapters: AI SDK / Anthropic SDK packages outside `@dome/sdk` core,
  plus richer adapter-owned backoff/classification if soak shows provider
  failures are common;
- richer protocol adapters: MCP, HTTP, WebSocket, mobile, or voice surfaces
  over the same compiler-host and view boundaries, without privileged write
  APIs;
- richer quarantine storage: move the current JSON-backed quarantine state
  into operational DB storage only if it improves observability or reliability
  beyond the shipped inspect/reset flow;
- post-substrate LLM bundles: people/project/synthesis processors once the
  deterministic local loop is boring.

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
- [x] `serve --exclusive`: PID-file or lock so a second host does not race the
  first. V1 uses an always-on per-branch compiler-host lock instead of an
  opt-in flag.
- [x] Per-processor verbose logging:
  `dome serve --verbose --filter-processor dome.markdown.*`.
- [x] `status --json`: add per-processor recent-run summary once the status schema
  is stable.
- [x] SQLite foreign keys: enable `PRAGMA foreign_keys=ON` where applicable.
- [x] Bundle lockstep tests: assert shipped bundle manifests, capabilities, and
  docs/matrices agree.
- [x] Command-trigger uniqueness: reject duplicate view command names at
  registry/load time instead of letting runtime dispatch pick the first match.
- [x] Bundle module confinement: reject processor `module:` paths that are
  absolute, escape the bundle root, or bypass `processors/`.
- [x] Route-level harness coverage: add scenario/matrix dimensions for
  adoption, garden-signal, garden-schedule, garden-job, garden-answer, and
  view-command routes so fact invalidation, capability-use ledgering, and
  patch semantics are proven per dispatcher.
- [x] Fact invalidation generalization: before non-signal garden processors emit
  page facts, make inspected paths explicit in runner results or effects so
  stale fact replacement is not coupled to trigger `changedPaths`.

## V1 Exit Criteria

V1 is ready when the Claude Code acceptance scenario works against a real
vault:

1. `dome init ~/vaults/work` creates the repo, local working directories,
   config, orientation files, gitignore, and initial commit.
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
