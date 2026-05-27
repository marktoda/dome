# Implementation handoff — Dome v0.5 (ARCHIVAL)

> **Archival as of 2026-05-26.** v0.5 implementation is complete and in daily use. This doc was the post-design / pre-implementation handoff snapshot; its inline counts and surface listings are frozen at that moment and **do not reflect current state**. The canonical entry points for current substrate are:
>
> - `docs/VISION.md` — north star
> - `docs/index.md` — substrate catalog (specs, invariants, matrices, gotchas — kept current)
> - `docs/wiki/specs/sdk-surface.md` — the four-concept core + Tool catalog + Tiered feature model + Consumer surfaces
> - `docs/wiki/specs/cli.md` — current CLI command set
> - `src/types.ts` `INVARIANTS` — the typed const of named invariants
>
> The body below is preserved for historical reference. **Do not edit it to "keep it current"** — count drift in handoff docs is what `docs/wiki/gotchas/substrate-count-drift.md` exists to prevent. If you need an implementation entry point, read the substrate catalog instead.

---

You are picking up where the design conversation left off. The design substrate is complete, validated through five repair passes, and is now the canonical source. **Don't try to re-derive the design from this handoff** — the substrate docs are authoritative. This handoff names what to read, in what order, and the few load-bearing decisions you should not silently revisit.

## What to read, in order

1. **`docs/VISION.md`** — north star. One read; sets expectations.
2. **`docs/cohesive/delta-ledgers/2026-05-25-dome-v0.5-foundation.md`** — the design delta ledger. The `## Delta at a glance` preamble enumerates everything the SDK must satisfy. The `## Repair pass 2` through `## Repair pass 5 (continued)` sections describe how the design evolved across review passes — useful for understanding *why* certain choices were made.
3. **`docs/index.md`** — the substrate vault's catalog. Skim to see what specs / invariants / matrices / gotchas exist.
4. **`docs/wiki/specs/sdk-surface.md`** — the most load-bearing single doc. Carries the four-concept core, the 7-Tool catalog, the canonical Tool signatures (Zod-derivable), the tiered feature model, the registration mechanism, the runtime + dependency list, the commit policy, and the §"Why this design" principles. **Read in full.**
5. **`docs/wiki/specs/vault-layout.md`** — directory structure, category derivation from path, ownership rules, derived operational state.
6. **`docs/wiki/specs/hooks.md`** — hook registration (programmatic + declarative), shipped defaults (`auto-update-index`, `auto-cross-reference`), opt-in intake patterns (`intake-raw` shipped-default + four opt-in), durability and reconciliation (3 phases), commit policy, cycle prevention.
7. **`docs/wiki/specs/prompts-and-workflows.md`** — workflow-prompt frontmatter, the 9 shipped workflows, override layering, eval suite.
8. **`docs/wiki/specs/cli.md`** — 7 commands. Every CLI command maps to either a Tool sequence (deterministic) or a workflow (LLM-driven). The flags list under `dome doctor` is canonical.
9. **`docs/wiki/specs/mcp-surface.md`** — MCP server. One MCP tool per SDK Tool (snake_case wrappers); MCP prompts expose workflow prompts; MCP resources expose vault content.
10. **`docs/wiki/specs/harnesses.md`** — Claude Code is the v0.5 reference harness. The headless agent loop covers `dome lint`, `dome export-context`, scheduled hooks.
11. **`docs/wiki/specs/page-schema.md`** — frontmatter contract per page type. Read after vault-layout.
12. **All 12 invariants under `docs/wiki/invariants/`** — every invariant doc carries: statement, why, structural enforcement, counter-example, test guarantee (`tests/invariants/<NAME>.test.ts`). Tier matters: 6 axioms (always-on), 4 shipped-defaults (opt-out per vault config), 2 opt-in (off by default). Read all 12; they're terse and load-bearing.
13. **All 3 matrices under `docs/wiki/matrices/`** — the canonical cross-references. `tool-invariant-enforcement` is the implementation contract for invariant enforcement at each Tool's call site.
14. **All 8 gotchas under `docs/wiki/gotchas/`** — failure modes the design anticipates. Each gotcha names its mitigation; the mitigations are normative.
15. **`docs/raw/original-architecture.md`** — the original design seed (Karpathy-LLM-Wiki pattern). Immutable historical reference; read if you want the lineage but the specs supersede it.

You can skip the brainstorm, substrate-discovery, and review files unless you want the archeology. The 5 validation reviews under `docs/cohesive/reviews/` are useful if you hit ambiguity — the reviewer agent's pass-by-pass findings show what was fuzzy and how it got resolved.

## Load-bearing decisions you should NOT silently revisit

These were locked across the five repair passes. Some seem unusual; each has explicit reasoning in the substrate.

- **TypeScript on Bun.** Not Node. Use Bun's built-in test runner, file watcher, `Bun.write` atomic writes. `isomorphic-git` for git ops (not `simple-git` — no native git binary requirement).
- **Seven Tools, sealed.** `readDocument`, `writeDocument`, `appendLog`, `searchIndex`, `wikilinkResolve`, `moveDocument`, `deleteDocument`. The seal is named in `sdk-surface.md` §"Tool catalog" and the anti-concept list. No 8th Tool in v0.5 — if you find yourself needing one, write it as a workflow (a prompt with frontmatter) or as a Hook reacting to existing Tool effects.
- **Four-concept core: Vault, Document, Tool, Hook.** No fifth primitive. Workflows, Agents, Events, Plugins, Intakes are *patterns* on these four — see sdk-surface §"Outputs the SDK does not have."
- **Every vault is a git repo.** `openVault(path)` refuses non-git directories. `dome init` runs `git init` + initial commit. This is axiom-tier (`VAULT_IS_GIT_REPO`).
- **Per-workflow auto-commit by default.** Each workflow's effects + log entry land as one atomic git commit. The commit subject equals the log.md entry's `## [date] verb | subject` header. `git revert <commit>` is universal undo. Configurable via `git.auto_commit_workflows: false`.
- **State-based reconciliation; no lockfiles.** `dome reconcile` runs 3 phases: inbox processing, git-diff replay, scheduled catchup. No `.dome/in-flight/` directory; crash recovery is derived from `git status` + idempotency contract on hooks.
- **Hook cycle prevention: per-(handler, target-path) repetition check + depth safety net (default 50).** NOT a depth-only mechanism — legitimate fan-out (e.g., `auto-cross-reference` writing backlinks across 30 entity pages) must be allowed.
- **`index.md` and `log.md` are dispatcher-owned.** Public Tools (`writeDocument`, `moveDocument`, `deleteDocument`) reject these paths unconditionally with `Result.err({ kind: 'dispatcher-owned-path' })`. The dispatcher exposes a privileged internal API (`dispatcher.writeIndex(entry)`, `dispatcher.appendLogEntry(entry)`) accessible to shipped-default hooks via a `dispatcher` field on the `HookContext` that's `undefined` for plugin / vault-local handlers. This is axiom-tier (`INDEX_AND_LOG_ARE_DISPATCHER_OWNED`).
- **Workflows are prompts, not configuration files.** A workflow IS a markdown prompt with workflow frontmatter (`type: workflow-prompt`, `name:`, `tools:`, `triggers:`). The SDK ships 9 workflows under `prompts/`. Vaults override by placing a same-named file in `.dome/prompts/`.
- **Sensitivity classification is a sub-workflow inside `ingest`, NOT a hook.** When `SENSITIVE_GOES_TO_INBOX` is enabled, the `ingest` workflow's prompt runs the `sensitivity-classify` sub-workflow BEFORE any `writeDocument` to `wiki/`. The invariant gates the write destination; a post-write hook would not have this property.
- **The count rule.** Constraint counts ("four-concept core", "seven Tools", "six axioms") stay. Inventory counts (e.g., "8 gotchas", "9 workflows") are replaced with categorical references that point at the canonical list. Don't write "we have N X's" in code comments unless N is structural.
- **Markdown is the source of truth.** No SDK component holds canonical state in a database. The two derived files under `.dome/state/` (`last-reconciled-sha.txt`, `scheduled.json`) are rebuildable and gitignored. Plugin caches go under `.dome/<plugin-name>/cache/` if needed; the SDK base ships no `.dome/cache/` directory.

## Recommended implementation staging

The substrate doesn't dictate stages, but a sensible v0.5 sequence:

### Stage 1 — SDK foundation (the load-bearing core)

- `bun init` the package. Name: `@dome/sdk` (placeholder; final npm name TBD). Strict TypeScript config.
- The `Vault` class: open / config-load / registry-load.
- The `Document` type with computed accessors (`category`, `type`, `isImmutable`).
- The 7 Tools with Zod input schemas, the `ToolReturn<T>` shape, the `Effect` union. **Wire invariant enforcement at each Tool's call site** per the matrix at `docs/wiki/matrices/tool-invariant-enforcement.md`.
- The dispatcher's privileged API (`dispatcher.writeIndex`, `dispatcher.appendLogEntry`).
- Per-invariant unit tests under `tests/invariants/<NAME>.test.ts` — one file per invariant; the canonical test guarantees are spelled out in each invariant doc.
- `openVault(path)` enforcing `VAULT_IS_GIT_REPO`.

This stage is testable in isolation. Don't write any agent loop yet.

### Stage 2 — Hook system + shipped defaults

- The hook dispatcher: event taxonomy projection from Effects, async event queue (`p-queue`), sync opt-in, the per-(handler, target) repetition check + depth safety net, cycle detection emitting `hook.cycle-detected`, failure model (3-fail quarantine).
- Registration mechanism: SDK defaults → installed plugins → vault-local files; 5 registration kinds (Tool, Hook, Prompt, Page type, CLI command).
- `HookContext` type with conditional `dispatcher` field for built-in handlers.
- The 2 shipped default hooks: `auto-update-index`, `auto-cross-reference`.
- The `intake-raw` shipped-default declarative hook + its supporting hook-template loader.
- Filesystem watcher via `chokidar` for inbox/ + wiki/ + out-of-band-edit detection.
- Per-workflow atomic commit logic (collect Effects → apply → log → `git add <touched> && git commit`).
- `dome reconcile` (3 phases) using `isomorphic-git`.

### Stage 3 — Prompts + workflows + headless agent loop

- Prompt loader (3-source layered: SDK / plugin / vault-local). Override mechanism.
- The 9 shipped workflow prompts as markdown files in `prompts/`. The 5 shipped-default (`ingest`, `query`, `lint`, `migrate`, `export-context`) ship inert until invoked; the 4 opt-in (`research`, `voice-ingest`, `sensitivity-classify`, `clip-integrate`) ship as templates.
- Headless agent loop using `@anthropic-ai/sdk`: loads a workflow prompt, binds the declared tool subset, runs until stop turn.
- The `eval` test target (`bun test --eval`) with fixture vault + expected page-touch assertions.

### Stage 4 — MCP server + CLI

- MCP server using `@modelcontextprotocol/sdk` — 7 MCP tools mirroring the SDK Tools (snake_case), 9 MCP prompts mirroring the workflows, MCP resources for `index.md` / `log.md` / pages.
- The 7 CLI commands (`init`, `migrate`, `serve`, `reconcile`, `lint`, `doctor`, `export-context`). Use `commander` or `cac`. `dome serve` auto-runs `reconcile` at startup.
- The `dome doctor` flag set (9 flags per `cli.md`).

### Stage 5 — Dogfood + finalize

- Run `dome migrate` against the docs/ vault in this repo (already structured as a Dome vault — bootstrap will be a partial no-op).
- Run the eval suite against fixture conversations.
- Wire the Claude Code MCP config and validate against a real personal vault.

## Things that are DEFERRED — DO NOT IMPLEMENT in v0.5

These are listed in the ledger's Delta-at-a-glance preamble and surfaced by the validation reviews as deferred future work. If you find yourself implementing them, stop and check.

- Dispatcher-level structural enforcement for `INBOX_IS_EPHEMERAL` — currently workflow-prompt-enforced. The prompt instructions in `ingest`, `voice-ingest`, `research`, `clip-integrate` carry the move/delete-on-completion contract.
- Semantic linter rule specifications (`dome-lint-stale-inbox`, `dome-lint-workflow-tool-list-against-catalog`, count-drift check). The `dome doctor` command surface exists; specific lint rules ship later.
- Per-gotcha regression tests. Each gotcha doc describes a failure mode + mitigation, but no `tests/gotchas/<NAME>.test.ts` is mandated for v0.5. Invariant tests are mandated; gotcha tests are not.
- HTTP/SSE MCP transport (`dome serve --port <n>`). Stdio only for v0.5; HTTP follows in v0.5.1+ once a use case demands it.
- Native mobile / desktop / web / voice clients. v0.5 is the SDK + MCP + CLI; clients are v1+.
- Multi-device sync. v0.5 is single-machine; sync is `git push` / `git pull` + manual `dome reconcile`.

## What's already done and shouldn't be re-touched

- The vault at `docs/` is itself a Dome vault. Don't restructure it or treat it as scratch space. It IS the canonical project substrate AND a working example of the architecture.
- The git history (15 commits) captures the design evolution. Don't rebase; `git log --oneline` is a useful audit surface.
- The 5 validation reviews under `docs/cohesive/reviews/` are persisted history. Don't edit them retroactively.

## Recommended tooling setup

The substrate names these libraries — use exactly these unless you have a strong reason:

- **Runtime:** Bun 1.x (not Node).
- **Language:** TypeScript 5.x with `"strict": true`.
- **LLM client:** `@anthropic-ai/sdk`.
- **MCP:** `@modelcontextprotocol/sdk`.
- **Git:** `isomorphic-git`.
- **File watcher:** `chokidar`.
- **Schema validation:** `zod`.
- **Frontmatter:** `gray-matter`.
- **Markdown AST:** `remark` + `unified` (only if you need it for body parsing; many use cases can string-manipulate).
- **Async queue:** `p-queue`.
- **Tests:** Bun's built-in test runner (`bun test`).

If you reach for `proper-lockfile`, `parcel-watcher`, `simple-git`, or `nodegit`, stop and re-read `wiki/sources/isomorphic-git-library.md` and the dependency list at `wiki/specs/sdk-surface.md` §"Dependencies (v0.5 baseline)". Those libraries were explicitly considered and rejected.

## How to know you're done with v0.5

Concrete acceptance:

1. `dome init <new-vault>` produces a working vault with `intake-raw` shipped-default hook + `inbox/raw/` directory + initial git commit.
2. Drop a file into `inbox/raw/`, run `dome reconcile`: file is ingested, wiki pages created/updated, file moved to `raw/captures/<ts>-<slug>.md`, log.md grows by one entry, git log shows the workflow's commit.
3. `bun test` runs and passes. Every invariant has at least one test asserting its enforcement.
4. `bun test --eval` runs against a fixture vault and asserts expected page-touch effects.
5. Claude Code session in a Dome vault directory with the MCP config sees all 7 MCP tools + 9 MCP prompts (5 default + 4 opt-in if activated).
6. `dome doctor` on a clean vault exits 0.

## Post-implementation

Run `cohesive:review-diff` on the implementation branch to catch any spec-drift the implementation introduced. The substrate carries 38+ docs that the code is expected to satisfy; review-diff is the structural check that the code matches.

---

Good luck. The substrate is dense but well-named; the canonical answer to any "what does X do" question is in `docs/wiki/`. When in doubt, read the spec; the spec is the contract.
