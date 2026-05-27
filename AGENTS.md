# AGENTS.md — Dome SDK repository

Orientation for agents and human contributors landing on `dome/`. This is the **repository-root** AGENTS.md, distinct from the *vault-root* AGENTS.md that every Dome-managed vault carries (see [[wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE]] for the per-vault contract).

## What this repo is

A TypeScript SDK on Bun — the four-concept Dome core (Vault, Document, Tool, Hook), seven Tools, the eight `dome` CLI commands, an MCP server, and a workflow runner. The `docs/` directory is itself a Dome vault dogfooding the SDK against its own design substrate.

The canonical substrate map is `docs/index.md`. Every spec, invariant, matrix, and gotcha is linked from there. **Read the substrate before changing code.**

## Where to start

By task shape:

- **Adding a Tool** — [[docs/wiki/specs/sdk-surface]] §"Tool catalog is one declarative array" (two file edits).
- **Adding a CLI command** — [[docs/wiki/specs/cli]] §"Adding a new command" (five file edits).
- **Adding a hook** — [[docs/wiki/specs/hooks]] §"Adding a new hook" (declarative / programmatic / shipped-default).
- **Adding a named invariant** — [[docs/wiki/specs/sdk-surface]] §"Adding a new invariant" (three file edits + AC3 lockstep).
- **Understanding the core/shell seal** — [[docs/wiki/invariants/CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY]] + [[docs/wiki/matrices/consumer-surface]].
- **Adding a new consumer surface** (HTTP, voice, future shells) — [[docs/wiki/specs/sdk-surface]] §"Consumer surfaces" (`AbstractSurface` + `renderXxx`).
- **Anything else** — start at `docs/index.md`.

By substrate type:

- **Specs** — `docs/wiki/specs/`. The normative contract for each subsystem.
- **Named invariants** — `docs/wiki/invariants/`. One file per invariant; `src/types.ts` `INVARIANTS` is the typed const.
- **Behavior matrices** — `docs/wiki/matrices/`. The cross-references between concepts.
- **Gotchas** — `docs/wiki/gotchas/`. Failure modes the design anticipates.
- **Linters** — `docs/wiki/linters/`. Convention-as-substrate rules (deferred / shipped).

## Load-bearing rules

- **The 16 named invariants are pinned by AC3 lockstep.** `tests/integration/invariant-coverage.test.ts` iterates `INVARIANTS` and requires `tests/invariants/<slug>.test.ts` per name. Off-matrix invariants delegate via `import(...)` to the canonical enforcement test — never via `expect(true).toBe(true)` (the no-op shape is rejected by the meta-check).
- **The four-concept core is sealed.** Vault, Document, Tool, Hook. Workflows, Agents, Events, Plugins, Intakes are patterns on these four, not separate primitives. See `docs/wiki/specs/sdk-surface.md` §"Outputs the SDK does not have."
- **`@dome/sdk` core has no LLM or MCP dependency.** `tests/integration/bundle-deps.test.ts` is the structural fence. Re-exporting `runWorkflow` from `src/index.ts` fails CI.
- **Markdown is the source of truth.** Anything Dome derives can be rebuilt from markdown alone. `.dome/state/` is gitignored and rebuildable.
- **Every vault is a git repo.** Axiom; enforced at `openVault`.
- **The compiler boundary** (`AGENTS.md` + CLI + daemon + reconcile) is the contract every agentic harness interacts with — see `docs/wiki/specs/harnesses.md`.

## How to run

- `bun test` — full suite (invariants + integration + tools + hooks + workflows + MCP).
- `bun test tests/invariants` — invariant lockstep only.
- `bin/dome <command>` — local CLI invocation.

## Repo layout

- `src/` — the SDK. Flat at the root for `Vault`, `Document`, `Hook`, `Tool` machinery; nested for `tools/`, `hooks/`, `workflows/`, `mcp/`, `cli/`, `prompts/`, `eval/`.
- `tests/` — bun test files. `tests/invariants/` is the AC3 surface; `tests/integration/` is the cross-cutting structural surface.
- `docs/` — the dogfood vault (substrate + reviews + delta ledgers + brainstorms + this repo's design history).
- `assets/dome-init/` — scaffolding `dome init` copies into new vaults.
- `bin/dome` — the CLI entrypoint script.

## Where this file came from

The pass-3 architecture review (`docs/cohesive/reviews/2026-05-26-dome-v0.5-to-v1-readiness-architecture-review.md`) flagged that the SDK repo had no repo-root orientation surface even though every *vault* it manages does. This file closes the asymmetry. Edits to it should preserve its role as the "first read for a new agent or contributor" — short, anchored to the canonical substrate, no inline counts.
