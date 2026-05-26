# Spec Cohesion Review — third repair pass for dome-compiler-reframe (commits 644b21d + c5e8051)

**Verdict:** Pass

## Executive judgment

The third repair pass closes both findings cleanly. `644b21d` propagates the two new invariants into `SHIPPED_VAULT_CONFIG.invariants` with `enabled` status, restoring the agreement between the `enabled`-filter projection both `agents-md.ts` and `abstract-surface.ts` use and the invariant set the compiler-reframe rewrite added. `c5e8051` registers `auto-update-index` against `vault.out-of-band-edit` with a third subscription (`auto-update-index-oob`) and discriminates branches inside the handler by `event.kind`, making `VAULT_RECONCILES_AFTER_NATIVE_WRITE.md §"Structural enforcement" path 1` a structural fact rather than an aspiration. The new watcher-path regression test pins the end-to-end behavior. 269/269 tests green.

## Closure check on the two prior-pass findings

**F1 (coverage, prior-pass High) — closed.** Both invariants declared `enabled` in `SHIPPED_VAULT_CONFIG.invariants`. `tests/agents-md.test.ts:54-55` pins their presence. Agreement between AGENTS.md templated section and MCP `instructions` projection restored.

**Substrate-I1 (prior-pass Medium) — closed.** Third subscription `auto-update-index-oob` against `vault.out-of-band-edit`. Handler branches on `event.kind`, filters to `wiki/`, maps `fsKind: "deleted"` to `removeIndexEntry` and everything else to `writeIndex`. End-to-end watcher regression test exercises the chokidar → dispatchEvents → hook → privileged-writer chain.

## No new defects introduced

- **NEW-B1 stays closed.** Tool-mediated writes still hit `writeIndex` once via the existing `document.deleted.*` / fall-through paths; the OOB branch only fires on `event.kind === "vault.out-of-band-edit"`. The Tool-write regression test still passes.
- **No self-trigger loop.** `index.md` and `log.md` live outside `VaultWatcher`'s target dirs (`wiki/`, `inbox/`, `raw/`, `notes/`), so privileged-writer updates don't re-fire `vault.out-of-band-edit`.
- **HOOKS_CANNOT_BYPASS_TOOLS unchanged.** The new subscription routes through the same `HookContext.privilegedWriter` gating.

## Architectural reflection

The compiler-boundary contract reads as a coherent four-surface story end-to-end. The two invariants the rewrite added are no longer special — they're enumerated by the same projection that already governed the original set, and the watcher-path enforcement is registered alongside the Tool-path subscriptions with the discriminator localized to a single hook handler.

- **Easier downstream:** Adding a future shipped-default invariant is a one-line change to `SHIPPED_VAULT_CONFIG.invariants` + `INVARIANTS`; the agents-md and MCP-instructions surfaces pick it up automatically.
- **Harder downstream:** A future reactive hook that needs to react to both Tool and watcher writes must explicitly enumerate both event-kind branches. The discriminator-inside-the-handler pattern is established but load-bearing.

## Next

**Disposition:** Approved — merge the worktree.
