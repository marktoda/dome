# Dome design substrate — Index

The catalog of all wiki pages in this vault. This vault's index is **curated by hand** — `dome.markdown.render-index` is disabled here via the explicit empty `index_categories: {}` config (see [[wiki/specs/vault-layout]] §"`index.md` — generated wiki catalogue" for the generated-render default).

This vault is the Dome project's own design substrate — a Dome instance dogfooding Dome itself.

New to the vocabulary? [[glossary]] is the one-page map: the four core types, the engine vocabulary, the content conventions, and the overloaded words (loop, signal, settle) disambiguated.

Installing Dome on your own machine? [[getting-started]] is the clone → vault → daemon → first-morning-brief walkthrough (the WS6 second-user script), every command verified against a scratch vault.

Working in the codebase? [[philosophy]] is the house style — pure-decide + thin shells, named invariants with mechanical enforcers, locality > centralization, depth as the test of a seam, and when generalizing at N=1 is the right call.

## Current Product Planning

- [[cohesive/plans/2026-07-11-productization-modernization]] — completed recovery/productization baseline: operational truth, performance, first-run loop, language, distribution rehearsal, and evidence gates.
- [[cohesive/plans/2026-07-11-pwa-first-product]] — current product plan: one owner, one vault, one supervised host, many authenticated clients; safe mediated mutation and vertical PWA slices toward an owner-appliance beta.
- [[v1]] — V1 design and plan: source-preserving convergent maintenance loops for Mark's work vault; processors remain the execution primitive, loops are the automation design unit.
- [[wedge]] — superseded product wedge plan (2026-06-09), retained as decision history for the five shipped phases.
- [[memory]] — Memory-quality plan (2026-06-09): five mechanisms (BM25++ retrieval, page supersession, core.md, dismissal discounting, preference promotion) as conventions + deterministic rebuildable facts; embeddings banked as a recomputable-cache spec, miss-log gated.
- [[daily]] — Daily-surface plan (2026-06-10): the daily as a three-act console (morning edition / live surface / close); section contract, one yesterday-block, owned capture block, close scaffold, edition health loop.

## Specs

- [[wiki/specs/owner-attention]] — one ranked owner queue derived from real decisions and proposal reviews
- [[wiki/specs/agent-work]] — derived, revision-safe work packets for evidence-backed agent resolution
- [[wiki/specs/semantic-gardening]] — one proposal-only semantic-maintenance module: deterministic opportunities, stateless coverage, proposal decisions as memory, and the shared `garden` view

- [[wiki/specs/sdk-surface]] — The four-concept core (Vault, Proposal, Processor, Effect); Recall + engine-control surfaces; extension bundles; shared operation seams; dependency list.
- [[wiki/specs/proposals]] — The Proposal type; the only write path; local-eventual and hosted-protected construction.
- [[wiki/specs/processors]] — The Processor type; three phases (adoption / garden / view); triggers; capabilities; first-party `dome.*` processors; idempotency.
- [[wiki/specs/processor-execution]] — Processor invocation state machine; timeouts; output validation; model structured-output failures; retries; quarantine; drain/shutdown.
- [[wiki/specs/effects]] — The ten-kind Effect taxonomy (Patch / Diagnostic / Fact / SearchDocument / Question / ExternalAction / OutboxRecovery / QuarantineRecovery / RunRecovery / View); SourceRef shape; exhaustive routing.
- [[wiki/specs/adoption]] — The fixed-point adoption loop; `refs/dome/adopted/<branch>`; Dome-* trailer convention; `dome sync` / `dome status`.
- [[wiki/specs/projection-store]] — Bun.sqlite-backed projection (facts, fts5, diagnostics, questions, schedule cursors); rebuild path; outbox is adjacent operational state.
- [[wiki/specs/recall]] — Natural-language lexical recall: shared query analysis, bounded minimum-match candidates, projection-memory coherence, and outcome canaries.
- [[wiki/specs/embeddings]] — Banked dense-retrieval design (not implemented): `dome.model-provider.embed/v1` envelope; `model.embed` capability; `embeddings.db` as the recomputable-cache store class; brute-force-cosine third RRF channel; gated on the `retrieval-misses.md` log.
- [[wiki/specs/capabilities]] — Seventeen capability tiers; manifest declarations; vault grants; broker enforcement at one chokepoint.
- [[wiki/specs/run-ledger]] — RunRecord per processor invocation; CapabilityUse; dual provenance with engine commit trailers.
- [[wiki/specs/cli]] — The Dome CLI: primary compiler loop (`serve` / `sync` / `status` / `check` / `resolve`), capture ingress (`capture`), adopted-state recall surfaces (`query`, `export-context`, the CLI-native activity view `log`), and hidden advanced/compatibility commands (`inspect`, `doctor`, `lint`, `answer`, `run`, `rebuild`, daily view wrappers).
- [[wiki/specs/capture]] — The capture loop end-to-end: `dome capture`, the raw-capture file shape under `inbox/raw/`, the phone/voice ingress recipe (what ships vs. what the user assembles), and the remote-capture seam contract (commit-or-nothing; owner trust domain; `performCapture` as reference implementation).
- [[wiki/specs/foreground-compiler-workflow]] — Day-to-day Claude Code workflow with `dome serve`, commit-boundary compilation, host-off catch-up, and the recovery loop.
- [[wiki/specs/mcp-surface]] — MCP server: the shipped `dome mcp` stdio adapter (wedge Phase 5) — typed capture/query/export_context/report_miss/status/check/resolve/settle/tasks/brief/proposals/apply_proposal/reject_proposal tools over the same handlers the CLI uses.
- [[wiki/specs/http-surface]] — HTTP surface: the shipped `dome http` read+capture adapter (bearer-token; loopback/Tailscale) — POST /capture implements the remote-capture seam; status/query/tasks/doc/questions/resolve read routes.
- [[wiki/specs/product-host]] — shipped Dome Home host contract: one owner/one vault/many paired clients; authority, readiness, operation classes, lifecycle, backup, and upgrade recovery.
- [[wiki/specs/controlled-mutation]] — recovery-backed seam for Dome-mediated commits: expected bytes, bounded host coordination, crash journal, and conservative checkout repair.
- [[wiki/specs/harnesses]] — How agentic harnesses (Claude Code, Cursor, OpenCode, Codex, future agents) interact with Dome via the compiler-boundary contract (AGENTS.md + CLI + compiler host + git-native writes).
- [[wiki/specs/agent-host]] — The replaceable foreground-agent host: session protocol, agent workspace, and the seam between agents and the background compiler.
- [[wiki/specs/task-lifecycle]] — `^block-anchor` line identity (move-stable, not body-hash); the three deterministic `dome.daily` task processors (stamp / reconcile / normalize) and why garden-phase; the `lastHumanChangedAt` freshness rule; the warden pattern (questions-only integrity + answer-handler; no-op without a model).
- [[wiki/specs/daily-surface]] — The daily note as a product surface: the three acts (morning edition / live surface / close), the 24-hour choreography, the normative section contract and block-ownership tables, the edition's degradation ladder, the `dome.daily.edition` maintenance loop, and the `daily.*` doctor findings.
- [[wiki/specs/claims]] — The vault-general claim-line grammar (`**Key:** value *(as of date)* ^c…`); `dome.claims.stamp` (garden anchor stamper) and `dome.claims.index` (adoption fact emitter); the `dome.claim.coherence` maintenance loop; bi-temporal supersession model; anticipated consumers (nightly sweeper, `dome explain`, warden pre-filter).
- [[wiki/specs/autonomous-agents]] — Autonomous-agent capability: agent-as-processor model (no new primitive); `ctx.modelInvoke.step` provider-neutral tool-calling seam; ingest, semantic garden, and brief agents; the deterministic `dome.agent.active-projects` core-memory renderer; capability grants + two hard floors.
- [[wiki/specs/preferences]] — Preference promotion (memory-quality M5): the `preferences/signals.md` append-only signal convention; deterministic counter facts (`dome.preference.*`, rebuildable); Wilson 95% lower bound × 90-day freshness confidence; owner-needed promotion questions; the two-gated-writers contract for `core.md` (promotion-answer owns promoted-preferences, active-projects owns active-projects; every writer owns a distinct block, fence-pinned cross-bundle); OSB applied/violated lifecycle banked as follow-up.
- [[wiki/specs/sources]] — External-feed subscriptions (`dome.sources`): the per-subscription consent surface in vault config, the 15-minute stateless fetch scheduler, the generic `sources.fetch` outbox handler running vault-authored fetch commands (calendar shipped default-off; Slack supported, never shipped on), and the launchd-timer machinery it replaces.
- [[wiki/specs/page-schema]] — Frontmatter contract per page type; four defaults + extension protocol.
- [[wiki/specs/vault-layout]] — Directory structure; category from path; ownership rules; `attic/` as the engine-proposed archive destination for dead-stub pages; git repository structure; derived operational state under `.dome/state/`.

## Invariants

Axioms (non-disable-able), shipped defaults (opt-out), and opt-in invariants. Tier shown inline. Canonical inventory: `docs/wiki/invariants/*.md`.

- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — *(axiom)* `refs/dome/adopted/<branch>` points to the latest fully-adopted commit; advanced only after a clean fixed-point sync. Fast-forward-only.
- [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] — *(shipped default)* Vault root carries AGENTS.md as the canonical agent-orientation surface; richer templated-section refresh remains planned.
- [[wiki/invariants/AGENT_WORK_IS_DERIVED]] — *(shipped default)* agent work is compiled from open questions and owns no queue, claim, retry, or job store.
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — *(axiom)* Every vault state change — agent native write, vim save, garden-emitted patch, scheduled job — eventually flows through the engine's adoption loop.
- [[wiki/invariants/EMBEDDINGS_ARE_A_RECOMPUTABLE_CACHE]] — *(deferred)* Vectors in `embeddings.db` never hold truth, only acceleration; the cache may be deleted at any time with no correctness impact; no processor may read embeddings as facts.
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — *(axiom)* Every engine-produced commit carries `Dome-Run`, `Dome-Extension`, `Dome-Base`, `Dome-Source-Head` trailers in the message body; user out-of-band commits do not.
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — *(axiom)* `@dome/sdk` core does not transitively depend on `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk`.
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — *(axiom)* Mutation happens in exactly one module: `src/engine/core/apply-effect.ts`. Every Effect routes through this chokepoint.
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — *(axiom)* Every Effect passes through the broker before application; capability intersection determines allow / downgrade / deny.
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]] — *(shipped default)* Every Effect produces an audit record (run ledger row, projection table row, outbox row, or git trailer).
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — *(shipped default)* Every processor invocation writes one RunRecord row, regardless of phase or outcome.
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]] — *(axiom)* `Processor.run(ctx)` returns `Promise<Effect[]>`; no direct mutation surface.
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — *(axiom)* Every ExternalActionEffect is inserted into `outbox.db` before the external call; idempotency keys deduplicate retries.
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — *(shipped default)* Intake bucket files should move/delete on processing; stale-inbox diagnostics surface lingering files.
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — *(axiom)* `log.md` entries are never rewritten; the planned `dome.log` append projection is retired — `log.md` is frozen and activity is git history, superseded by NO_ACCRETING_REGISTRIES.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — *(axiom)* Markdown + git are canonical knowledge; `.dome/state/` is operational/derived state.
- [[wiki/invariants/MODEL_PROCESSORS_EMIT_NO_DURABLE_FACTS]] — *(axiom)* A garden-phase `model.invoke` processor never declares `graph.write`; model judgment surfaces as a question (durable via `answers.db`) or a regenerated surface patch, never a `FactEffect` that would vanish on rebuild.
- [[wiki/invariants/NEEDS_ARE_LOUD]] — *(shipped default)* A processor whose declared capability has an empty effective grant intersection, or whose declared `*.read` context accessor is absent at run time, still runs but surfaces a `processor.need-unmet` warning (deduped per session). The run-time complement of `dome doctor`'s config-time grant-starvation probes; silent degradation on a declared need is a defect.
- [[wiki/invariants/NO_ACCRETING_REGISTRIES]] — *(shipped default)* every central vault artifact is curated source-of-truth markdown or a deterministic render from per-item sources; index files render from `description:` frontmatter, the activity log is git history (`dome log`), `log.md` is frozen.
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — *(axiom)* `projection.db` can be wiped and rebuilt from the adopted commit + processor set.
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — *(axiom)* Every trusted-state mutation routes through an internally-constructed Proposal and the adoption loop; no direct-write SDK API.
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — *(axiom)* Raw files are immutable after creation; broker raw-patch denial plus `dome.markdown.raw-immutable` block committed mutations.
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — *(axiom)* Every Dome vault is a git repository.

## Matrices

- [[wiki/matrices/built-in-extensions-x-phase]] — First-party `dome.*` bundles × adoption/garden/view × shipped processors.
- [[wiki/matrices/effect-router-targets]] — Effect kind × processor phase → engine routing destination.
- [[wiki/matrices/effect-x-capability]] — Per-Effect-kind capability requirements at the broker.
- [[wiki/matrices/engine-module-map]] — `src/engine/`'s four internal layers (core / garden / operational / host); module → layer assignment; downward-only import rule; lockstep with `tests/integration/engine-import-direction.test.ts`.
- [[wiki/matrices/extension-bundle-shape]] — Per-bundle file map; seven contribution kinds (page-types, preamble, processors, external-handlers, capability-grants, loops, doctor grant-entry probes).
- [[wiki/matrices/intent-prompt-processors]] — User intent × prompt source × processor that handles them × effects emitted.
- [[wiki/matrices/processor-phase-x-trigger]] — Phase × trigger compatibility; what's allowed where.
- [[wiki/matrices/projection-table-x-owner]] — Per-projection-table writer authority; namespace scoping.
- [[wiki/matrices/protocol-adapter]] — CLI / MCP / HTTP / AgentRuntime mapped to the shared Vault and operation seams.
- [[wiki/matrices/pwa-product-acceptance]] — versioned installed-product journey and adversarial release matrix for the PWA-first owner appliance.

## Gotchas

- [[wiki/gotchas/adopted-ref-divergence]] — Force-push / hard-reset / rebase rewrites HEAD so adopted ref is no longer an ancestor; sync refuses, serve pauses, health raises one `adopted-ref.diverged` finding; recovery is `dome reanchor` (backs up the old SHA under refs/dome/backup/ first) or a git reflog restore.
- [[wiki/gotchas/agent-prompt-regression]] — Model upgrades or prompt edits can change behavior silently.
- [[wiki/gotchas/agents-md-delimiter-shape]] — Editing the user-prose delimiter strings in the invariant doc without updating `src/agents-md.ts` destroys user prose on the next `--repair`.
- [[wiki/gotchas/ai-sdk-tool-variance]] — Garden-LLM processors handle AI SDK v6 inference; revisit on next AI SDK major bump.
- [[wiki/gotchas/async-read-after-write-staleness]] — Reads immediately after a git-native write may not see garden-phase follow-on; queries default to adopted, not HEAD.
- [[wiki/gotchas/boundary-validation-via-zod]] — YAML and JSON persistence boundaries Zod-validate; corruption surfaces as state-corruption diagnostics.
- [[wiki/gotchas/capability-downgrade-surprise]] — `patch.auto` exceeding grant downgrades to `patch.propose` with a diagnostic.
- [[wiki/gotchas/concurrent-harness-write]] — Two harness sessions in the same vault race on writes; both produce Proposals; adoption loop sequences them.
- [[wiki/gotchas/daemon-off-while-vault-mutating]] — Compiler host off; catch-up cost grows linearly with time-since-last-sync.
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — `dome sync` refuses to run during mid-merge / mid-rebase.
- [[wiki/gotchas/extension-bundle-load-order]] — Two bundles declare the same page-type / processor / capability handler; `openVault` rejects with `bundle-load-failure`.
- [[wiki/gotchas/garden-cascade-cap]] — Garden-emitted PatchEffects can recursively spawn sub-Proposals; depth cap (default 10) emits `garden.cascade-cap` diagnostic on hit.
- [[wiki/gotchas/linked-worktree-gitdir-split]] — Linked worktrees split HEAD/index from common refs/objects; the complete `src/git.ts` Interface routes through native Git in that layout.
- [[wiki/gotchas/multi-page-partial-write]] — Multi-page Proposals that adopt only some pages on block — atomic adoption mitigates.
- [[wiki/gotchas/out-of-band-vault-edits]] — Native writes from consumer shells (canonical path); the compiler host catches committed branch movement and constructs Proposals.
- [[wiki/gotchas/operator-surfaces-enumerate-first-party]] — Third-party bundles are first-class at the effect/capability layer but second-class on operator surfaces; converted (loops, shared config) vs remaining (doctor findings, diagnostic rendering hints) shadow contribution kinds, with conversion paths.
- [[wiki/gotchas/outbox-stuck]] — External-action retries exhausted; `dome check` reports it and `dome.health` questions plus `dome resolve` recover retry/abandon decisions.
- [[wiki/gotchas/processor-fixed-point-divergence]] — Adoption loop hits MAX_ITER cap; processors named in the diagnostic.
- [[wiki/gotchas/processor-idempotency]] — Non-deterministic processors break the fixed-point loop and `dome rebuild`.
- [[wiki/gotchas/processor-version-drift]] — Processor version bump invalidates the affected projection rows; auto-re-run on `openVault`.
- [[wiki/gotchas/projection-schema-skew]] — SDK upgrade changes the projection schema; auto-rebuild on `openVault`.
- [[wiki/gotchas/scheduled-hook-idempotency]] — Schedule-driven processors fire at-most-once per sync regardless of intervals missed.
- [[wiki/gotchas/substrate-count-drift]] — Synthesis docs inline counts that diverge from canonical const arrays.
- [[wiki/gotchas/transitive-llm-dependency]] — Consumer bundles unexpectedly carry Anthropic + MCP because core re-exported LLM/MCP machinery.

## Linters

Named semantic linter specs. Each names the rule, what it checks, and the target version.

- [[wiki/linters/engine-import-direction]] — *(v1)* Every `src/engine/` module lives in its [[wiki/matrices/engine-module-map]] layer directory and imports only same- or lower-ranked layers (core < garden < operational < host).
- [[wiki/linters/engine-is-sole-applier]] — *(v1)* `src/` outside `src/engine/`, `src/projections/`, `src/ledger/`, `src/outbox/` must not import mutation modules (`node:fs`, `bun:sqlite`, `isomorphic-git` write functions).
- [[wiki/linters/generated-block-splice-guard]] — *(v1)* Every non-test file under `src/` and `assets/extensions/` whose source constructs a generated-block marker (`:start -->`/`:end -->` or a `dome.`-prefixed comment) must import the grammar primitive `src/core/generated-block.ts`.
- [[wiki/linters/no-direct-mutation-outside-engine]] — *(v1)* Greps `src/` for mutation calls outside the engine boundary; complement to `engine-is-sole-applier`.
- [[wiki/linters/no-retired-symbol-names]] — *(v1)* Every normative doc names no symbol in the retired-names allow-list (`Tool`, `Hook`, `Workflow`, `BoundToolSurface`, `runWorkflow`, `reconcile`, `wrapMutatingInvoke`, `INDEX_AND_LOG_ARE_DISPATCHER_OWNED`, `HOOKS_CANNOT_BYPASS_TOOLS`, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `PAGE_CREATION_REQUIRES_RECURRENCE`, `WORKFLOWS_KNOW_VAULT_CONTEXT`, …).
- [[wiki/linters/processor-purity]] — *(v1)* Files under `assets/extensions/*/processors/` and `<vault>/.dome/extensions/*/processors/` must not import mutation modules.
- [[wiki/linters/surface-adapters-dont-import-adapters]] — *(v1)* `src/mcp/` never imports `src/cli/`; `src/cli/` never imports `src/mcp/` (host shim `src/cli/commands/mcp.ts` excepted); `src/surface/` never imports an adapter.

## Entities

- [[wiki/entities/andrej-karpathy]] — Source of the LLM-wiki pattern.
- [[wiki/entities/anthropic]] — Vendor of the model + SDK Dome's harnesses depend on.
- [[wiki/entities/bun]] — JavaScript runtime + toolkit; the Dome SDK runtime.
- [[wiki/entities/claude-code]] — Anthropic's CLI; Dome v1's first official harness.
- [[wiki/entities/git]] — The version control system underpinning Dome's adoption, undo, and sync.
- [[wiki/entities/isomorphic-git]] — Pure-JS git implementation; the Dome SDK's git engine.
- [[wiki/entities/mcp-protocol]] — Model Context Protocol; the wire format `dome mcp` speaks for harnesses that mount the Dome MCP server.
- [[wiki/entities/obsidian]] — Markdown editor; Dome's recommended browse surface.
- [[wiki/entities/typescript]] — Dome SDK's implementation language.

## Concepts

- [[wiki/concepts/brain-companion]] — Dome's product framing: ambient, always-accessible memory.
- [[wiki/concepts/client-model]] — The three-layer client model: the user operates a client (primarily an LLM agent) over the compiled vault; the contract is the product; the CLI is admin/agent-tool/gap-filler.
- [[wiki/concepts/llm-wiki-pattern]] — Karpathy's pattern: LLM as wiki maintainer, raw immutable, wiki synthesized.
- [[wiki/concepts/surface-view-model]] — Surface views as three tiers (validated `/vN` payload contract → consumer view-model → thin protocol painters); `dome.daily.today/v1` is the exemplar, `status` is next.

## Sources

- [[wiki/sources/isomorphic-git-library]] — The isomorphic-git library and why Dome depends on it.
- [[wiki/sources/karpathy-llm-wiki-gist]] — Summary of Andrej Karpathy's LLM-wiki gist and its influence on Dome.

## Syntheses

- [[wiki/syntheses/dome-as-compiler]] — Tests the "compiler for your second brain" framing against real compiler construction: anatomy map (compileRange = incremental compilation, SourceRef = source maps, rebuildable projections = hermetic cache), where the analogy breaks (stochastic optimizer; "language server for prose" reframing), and borrowable ideas (LSP as a third `render*` adapter, query-based incremental engine, `dome explain` provenance debugger).
- [[wiki/syntheses/v0.5-build-plan]] — The v0.5 → v1 sequencing (historical).
- [[wiki/syntheses/why-dome-vs-mem-tana-granola]] — Positioning against the existing PKM landscape.
