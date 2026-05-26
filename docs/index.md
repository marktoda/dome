# Dome design substrate — Index

The catalog of all wiki pages in this vault. Maintained by Dome's tools; entries added when pages are created, sorted alphabetically within each section.

This vault is the Dome project's own design substrate — a Dome instance dogfooding Dome itself.

## Specs

- [[wiki/specs/cli]] — The 7-command Dome CLI: init, migrate, serve, reconcile, lint, doctor, export-context.
- [[wiki/specs/harnesses]] — How Claude Code, Cursor, and future native clients mount Dome via MCP.
- [[wiki/specs/hooks]] — Hook registration, shipped defaults, opt-in intakes, durability and reconciliation.
- [[wiki/specs/mcp-surface]] — MCP server: one MCP tool per SDK tool.
- [[wiki/specs/page-schema]] — Frontmatter contract per page type; four defaults + extension protocol.
- [[wiki/specs/prompts-and-workflows]] — Prompt library; workflows as prompts with frontmatter; tier-classified workflows.
- [[wiki/specs/sdk-surface]] — The four-concept core (Vault, Document, Tool, Hook), Tool catalog, tiered feature model, why-this-design principles, dependency list.
- [[wiki/specs/vault-layout]] — Directory structure, category from path, ownership rules, git repository structure, derived operational state.

## Invariants

Axioms (non-disable-able), shipped defaults (opt-out), and opt-in invariants. Tier shown inline. Canonical const: `src/types.ts` `INVARIANTS`.

- [[wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] — *(axiom)* `@dome/sdk` core does not transitively depend on `@anthropic-ai/sdk`, `ai`, or `@modelcontextprotocol/sdk`.
- [[wiki/invariants/EVERY_WRITE_IS_LOGGED]] — *(shipped default)* Every mutation produces an appendLog call.
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]] — *(axiom)* Hooks observe and call Tools; never mutate directly.
- [[wiki/invariants/INBOX_IS_EPHEMERAL]] — *(shipped default)* Intake hooks must move/delete inbox files on completion; presence = pending.
- [[wiki/invariants/INDEX_AND_LOG_ARE_DISPATCHER_OWNED]] — *(axiom)* index.md and log.md mutated only by dispatcher.writeIndex / dispatcher.appendLogEntry; public Tools reject these paths.
- [[wiki/invariants/LOG_IS_APPEND_ONLY]] — *(axiom)* log.md mutated only by appendLog.
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]] — *(axiom)* Derived state rebuildable from markdown; `.dome/state/` is explicitly derived.
- [[wiki/invariants/PAGE_CREATION_REQUIRES_RECURRENCE]] — *(opt-in)* New pages require an explicit creation reason.
- [[wiki/invariants/PAGE_TYPE_BY_DIRECTORY]] — *(shipped default)* Page type from immediate wiki/ subdirectory.
- [[wiki/invariants/RAW_IS_IMMUTABLE]] — *(axiom)* writeDocument refuses raw/.
- [[wiki/invariants/SENSITIVE_GOES_TO_INBOX]] — *(opt-in)* Sensitive content routes via writeDocument to inbox/review/.
- [[wiki/invariants/VAULT_IS_GIT_REPO]] — *(axiom)* Every Dome vault is a git repository.
- [[wiki/invariants/WIKILINKS_ARE_FULLPATH]] — *(shipped default)* [[wiki/entities/x]] not [[x]].

## Matrices

- [[wiki/matrices/consumer-surface]] — Consumer shell × exported symbol family × entrypoint (`core` / `workflows` / `mcp` / `cli`).
- [[wiki/matrices/event-types-and-payloads]] — Event name × emitting tool × payload × example hooks.
- [[wiki/matrices/intent-prompt-tools]] — User intent × workflow prompt × bound tools × effects.
- [[wiki/matrices/tool-invariant-enforcement]] — Tool × invariant enforcement matrix.

## Gotchas

- [[wiki/gotchas/agent-prompt-regression]] — Model upgrades or prompt edits can change behavior silently.
- [[wiki/gotchas/ai-sdk-tool-variance]] — Registry's `Tool<>` cast bridges AI SDK v6 inference mismatch; revisit on next AI SDK major bump.
- [[wiki/gotchas/async-read-after-write-staleness]] — Reads immediately after writes may not see hook follow-on.
- [[wiki/gotchas/concurrent-harness-write]] — Two harness sessions in the same vault race on writes.
- [[wiki/gotchas/dirty-git-state-at-reconcile]] — `dome reconcile` refuses to run during mid-merge / mid-rebase.
- [[wiki/gotchas/hook-cycle]] — Hook A triggers Tool that fires event that triggers hook A.
- [[wiki/gotchas/hook-non-idempotent]] — Non-idempotent hooks double-fire effects during reconciliation.
- [[wiki/gotchas/multi-page-partial-write]] — Multi-page updates that fail partway through.
- [[wiki/gotchas/out-of-band-vault-edits]] — Obsidian or vim writes that bypass Dome's tools.
- [[wiki/gotchas/substrate-count-drift]] — Synthesis docs inline counts that diverge from canonical const arrays.
- [[wiki/gotchas/transitive-llm-dependency]] — Consumer bundles unexpectedly carry Anthropic + MCP because core re-exported LLM/MCP machinery.

## Entities

- [[wiki/entities/andrej-karpathy]] — Source of the LLM-wiki pattern.
- [[wiki/entities/anthropic]] — Vendor of the model + SDK Dome's harnesses depend on.
- [[wiki/entities/bun]] — JavaScript runtime + toolkit; the Dome SDK runtime.
- [[wiki/entities/claude-code]] — Anthropic's CLI; Dome v0.5's first official harness.
- [[wiki/entities/git]] — The version control system underpinning Dome's reconciliation, undo, and sync.
- [[wiki/entities/isomorphic-git]] — Pure-JS git implementation; the Dome SDK's git engine.
- [[wiki/entities/mcp-protocol]] — Model Context Protocol; how Dome exposes tools to harnesses.
- [[wiki/entities/obsidian]] — Markdown editor; Dome's recommended browse surface.
- [[wiki/entities/typescript]] — Dome SDK's implementation language.

## Concepts

- [[wiki/concepts/brain-companion]] — Dome's product framing: ambient, always-accessible memory.
- [[wiki/concepts/llm-wiki-pattern]] — Karpathy's pattern: LLM as wiki maintainer, raw immutable, wiki synthesized.

## Sources

- [[wiki/sources/isomorphic-git-library]] — The isomorphic-git library and why Dome depends on it.
- [[wiki/sources/karpathy-llm-wiki-gist]] — Summary of Andrej Karpathy's LLM-wiki gist and its influence on Dome.

## Syntheses

- [[wiki/syntheses/v0.5-build-plan]] — The v0.5 → v1+ → long-term sequencing.
- [[wiki/syntheses/why-dome-vs-mem-tana-granola]] — Positioning against the existing PKM landscape.
