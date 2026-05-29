# Dome design substrate — Index

The catalog of all wiki pages in this vault. In the current SDK it is maintained manually; a future `dome.index` bundle may own regeneration.

This vault is the Dome project's own design substrate — a Dome instance dogfooding Dome itself.

## Current v1 Planning

- [[wiki/syntheses/v1-claude-code-vault-plan]] — Product contract for the Claude Code vault workflow, compiler host modes, CLI priorities, first-party bundle cut, and hosted-queue runway.
- [[v1-roadmap]] — Living technical execution plan and shipped-status ledger for that product contract.

## Specs

- [[wiki/specs/sdk-surface]] — The four-concept core (Vault, Proposal, Processor, Effect); Recall + engine-control surfaces; extension bundles; tiered feature model; consumer surfaces via `AbstractSurface`; dependency list.
- [[wiki/specs/proposals]] — The Proposal type; the only write path; local-eventual and hosted-protected construction.
- [[wiki/specs/processors]] — The Processor type; three phases (adoption / garden / view); triggers; capabilities; first-party `dome.*` processors; idempotency.
- [[wiki/specs/processor-execution]] — Processor invocation state machine; timeouts; output validation; model structured-output failures; retries; quarantine; drain/shutdown.
- [[wiki/specs/effects]] — The eleven-kind Effect taxonomy (Patch / Diagnostic / Fact / SearchDocument / Question / Job / ExternalAction / OutboxRecovery / QuarantineRecovery / RunRecovery / View); SourceRef shape; exhaustive routing.
- [[wiki/specs/adoption]] — The fixed-point adoption loop; `refs/dome/adopted/<branch>`; Dome-* trailer convention; `dome sync` / `dome status`.
- [[wiki/specs/projection-store]] — Bun.sqlite-backed projection (facts, fts5, diagnostics, questions, schedule cursors); rebuild path; outbox is adjacent operational state.
- [[wiki/specs/capabilities]] — Seventeen capability tiers; manifest declarations; vault grants; broker enforcement at one chokepoint.
- [[wiki/specs/run-ledger]] — RunRecord per processor invocation; CapabilityUse; dual provenance with engine commit trailers.
- [[wiki/specs/cli]] — The Dome CLI: init / sync / serve / status / today / query / export-context / run / rebuild / inspect / doctor / answer, plus planned user-value aliases such as lint.
- [[wiki/specs/mcp-surface]] — MCP server: Recall-oriented protocol adapter over `AbstractSurface`; non-primary in v1.
- [[wiki/specs/harnesses]] — How agentic harnesses (Claude Code, Cursor, OpenCode, Codex, future agents) interact with Dome via the compiler-boundary contract (AGENTS.md + CLI + compiler host + git-native writes).
- [[wiki/specs/page-schema]] — Frontmatter contract per page type; four defaults + extension protocol.
- [[wiki/specs/vault-layout]] — Directory structure; category from path; ownership rules; git repository structure; derived operational state under `.dome/state/`.

## Invariants

Axioms (non-disable-able), shipped defaults (opt-out), and opt-in invariants. Tier shown inline. Canonical const: `src/types.ts` `INVARIANTS`.

- [[wiki/invariants/ADOPTED_REF_IS_SEMANTIC_CURSOR]] — *(axiom)* `refs/dome/adopted/<branch>` points to the latest fully-adopted commit; advanced only after a clean fixed-point sync. Fast-forward-only.
- [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] — *(shipped default)* Vault root carries AGENTS.md as the canonical agent-orientation surface; templated sections refreshed by `dome doctor --repair`.
- [[wiki/invariants/ALL_MUTATION_GOES_THROUGH_ADOPTION]] — *(axiom)* Every vault state change — agent native write, vim save, garden-emitted patch, scheduled job — eventually flows through the engine's adoption loop.
- [[wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS]] — *(axiom)* Every engine-produced commit carries `Dome-Run`, `Dome-Extension`, `Dome-Base`, `Dome-Source-Head` trailers in the message body; user out-of-band commits do not.
- [[wiki/invariants/ENGINE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — *(axiom)* `@dome/sdk` core does not transitively depend on `@ai-sdk/anthropic`, `ai`, or `@modelcontextprotocol/sdk`.
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]] — *(axiom)* Mutation happens in exactly one module: `src/engine/apply-effect.ts`. Every Effect routes through this chokepoint.
- [[wiki/invariants/EVERY_EFFECT_IS_CAPABILITY_CHECKED]] — *(axiom)* Every Effect passes through the broker before application; capability intersection determines allow / downgrade / deny.
- [[wiki/invariants/EVERY_EFFECT_IS_LEDGERED]] — *(shipped default)* Every Effect produces an audit record (run ledger row, projection table row, outbox row, or git trailer).
- [[wiki/invariants/EVERY_PROCESSOR_RUN_IS_LEDGERED]] — *(shipped default)* Every processor invocation writes one RunRecord row, regardless of phase or outcome.
- [[wiki/invariants/EFFECTS_ARE_THE_ONLY_PROCESSOR_OUTPUT]] — *(axiom)* `Processor.run(ctx)` returns `Promise<Effect[]>`; no direct mutation surface.
- [[wiki/invariants/EXTERNAL_EFFECTS_GO_THROUGH_OUTBOX]] — *(axiom)* Every ExternalActionEffect is inserted into `outbox.db` before the external call; idempotency keys deduplicate retries.
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — *(shipped default)* Intake bucket files must move/delete on processing; lingering files surface as diagnostics.
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — *(axiom)* log.md mutated only by `dome.log`'s append-only adoption processor.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — *(axiom)* Markdown + git are canonical knowledge; `.dome/state/` is operational/derived state.
- [[wiki/invariants/PROJECTIONS_ARE_REBUILDABLE]] — *(axiom)* `projection.db` can be wiped and rebuilt from the adopted commit + processor set.
- [[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]] — *(axiom)* Every trusted-state mutation routes through an internally-constructed Proposal and the adoption loop; no direct-write SDK API.
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — *(axiom)* PatchEffect refuses raw/.
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — *(axiom)* Every Dome vault is a git repository.

## Matrices

- [[wiki/matrices/built-in-extensions-x-phase]] — First-party `dome.*` bundles × adoption/garden/view × shipped processors.
- [[wiki/matrices/effect-router-targets]] — Effect kind × processor phase → engine routing destination.
- [[wiki/matrices/effect-x-capability]] — Per-Effect-kind capability requirements at the broker.
- [[wiki/matrices/extension-bundle-shape]] — Per-bundle file map; five contribution kinds (page-types, preamble, processors, external-handlers, capability-grants).
- [[wiki/matrices/intent-prompt-processors]] — User intent × prompt source × processor that handles them × effects emitted.
- [[wiki/matrices/processor-phase-x-trigger]] — Phase × trigger compatibility; what's allowed where.
- [[wiki/matrices/projection-table-x-owner]] — Per-projection-table writer authority; namespace scoping.
- [[wiki/matrices/protocol-adapter]] — CLI / MCP / future HTTP / Voice mapped to AbstractSurface operations.

## Gotchas

- [[wiki/gotchas/adopted-ref-divergence]] — Force-push / hard-reset / rebase rewrites HEAD so adopted ref is no longer an ancestor; sync refuses; recovery is currently manual via git history/reflog until the answer-mediated force-advance flow ships.
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
- [[wiki/gotchas/multi-page-partial-write]] — Multi-page Proposals that adopt only some pages on block — atomic adoption mitigates.
- [[wiki/gotchas/out-of-band-vault-edits]] — Native writes from consumer shells (canonical path); the compiler host catches committed branch movement and constructs Proposals.
- [[wiki/gotchas/outbox-stuck]] — External-action retries exhausted; `dome doctor` reports it and `dome.health` questions plus `dome answer` recover retry/abandon decisions.
- [[wiki/gotchas/processor-fixed-point-divergence]] — Adoption loop hits MAX_ITER cap; processors named in the diagnostic.
- [[wiki/gotchas/processor-idempotency]] — Non-deterministic processors break the fixed-point loop and `dome rebuild`.
- [[wiki/gotchas/processor-version-drift]] — Processor version bump invalidates the affected projection rows; auto-re-run on `openVault`.
- [[wiki/gotchas/projection-schema-skew]] — SDK upgrade changes the projection schema; auto-rebuild on `openVault`.
- [[wiki/gotchas/scheduled-hook-idempotency]] — Schedule-driven processors fire at-most-once per sync regardless of intervals missed.
- [[wiki/gotchas/substrate-count-drift]] — Synthesis docs inline counts that diverge from canonical const arrays.
- [[wiki/gotchas/transitive-llm-dependency]] — Consumer bundles unexpectedly carry Anthropic + MCP because core re-exported LLM/MCP machinery.

## Linters

Named semantic linter specs. Each names the rule, what it checks, and the target version.

- [[wiki/linters/engine-is-sole-applier]] — *(v1)* `src/` outside `src/engine/`, `src/projections/`, `src/ledger/`, `src/outbox/` must not import mutation modules (`node:fs`, `bun:sqlite`, `isomorphic-git` write functions).
- [[wiki/linters/no-direct-mutation-outside-engine]] — *(v1)* Greps `src/` for mutation calls outside the engine boundary; complement to `engine-is-sole-applier`.
- [[wiki/linters/no-retired-symbol-names]] — *(v1)* Every normative doc names no symbol in the retired-names allow-list (`Tool`, `Hook`, `Workflow`, `BoundToolSurface`, `runWorkflow`, `reconcile`, `wrapMutatingInvoke`, `INDEX_AND_LOG_ARE_DISPATCHER_OWNED`, `HOOKS_CANNOT_BYPASS_TOOLS`, `PAGE_TYPE_BY_DIRECTORY`, `WIKILINKS_ARE_FULLPATH`, `PAGE_CREATION_REQUIRES_RECURRENCE`, `WORKFLOWS_KNOW_VAULT_CONTEXT`, …).
- [[wiki/linters/processor-purity]] — *(v1)* Files under `assets/extensions/*/processors/` and `<vault>/.dome/extensions/*/processors/` must not import mutation modules.

## Entities

- [[wiki/entities/andrej-karpathy]] — Source of the LLM-wiki pattern.
- [[wiki/entities/anthropic]] — Vendor of the model + SDK Dome's harnesses depend on.
- [[wiki/entities/bun]] — JavaScript runtime + toolkit; the Dome SDK runtime.
- [[wiki/entities/claude-code]] — Anthropic's CLI; Dome v1's first official harness.
- [[wiki/entities/git]] — The version control system underpinning Dome's adoption, undo, and sync.
- [[wiki/entities/isomorphic-git]] — Pure-JS git implementation; the Dome SDK's git engine.
- [[wiki/entities/mcp-protocol]] — Model Context Protocol; how Dome exposes Submit / Recall to harnesses that mount the MCP server.
- [[wiki/entities/obsidian]] — Markdown editor; Dome's recommended browse surface.
- [[wiki/entities/typescript]] — Dome SDK's implementation language.

## Concepts

- [[wiki/concepts/brain-companion]] — Dome's product framing: ambient, always-accessible memory.
- [[wiki/concepts/llm-wiki-pattern]] — Karpathy's pattern: LLM as wiki maintainer, raw immutable, wiki synthesized.

## Sources

- [[wiki/sources/isomorphic-git-library]] — The isomorphic-git library and why Dome depends on it.
- [[wiki/sources/karpathy-llm-wiki-gist]] — Summary of Andrej Karpathy's LLM-wiki gist and its influence on Dome.

## Syntheses

- [[wiki/syntheses/dome-as-compiler]] — Tests the "compiler for your second brain" framing against real compiler construction: anatomy map (compileRange = incremental compilation, SourceRef = source maps, rebuildable projections = hermetic cache), where the analogy breaks (stochastic optimizer; "language server for prose" reframing), and borrowable ideas (LSP as a third `render*` adapter, query-based incremental engine, `dome explain` provenance debugger).
- [[wiki/syntheses/v1-claude-code-vault-plan]] — Product contract for the Claude Code vault workflow, compiler host modes, CLI priorities, first-party bundle cut, and hosted-queue runway.
- [[wiki/syntheses/v0.5-build-plan]] — The v0.5 → v1 sequencing (historical).
- [[wiki/syntheses/why-dome-vs-mem-tana-granola]] — Positioning against the existing PKM landscape.
