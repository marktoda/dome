---
type: invariant
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tier: axiom
---

# HOOKS_CANNOT_BYPASS_TOOLS

**Tier:** Axiom — non-disable-able.

**Statement:** A Hook handler (programmatic or declarative) observes events and may invoke Tools to produce follow-on mutations, but it cannot mutate the vault directly. Hooks have no filesystem write capability; they only have access to the Vault's Tool methods through their `ctx` argument.

**Why:** Without this invariant, hooks become a second mutation path that bypasses the Tool layer's invariant enforcement. A hook that writes directly to `wiki/entities/danny.md` skips `PAGE_TYPE_BY_DIRECTORY` validation, skips `EVERY_WRITE_IS_LOGGED`, skips sensitivity routing — all the structural mitigations collapse. Forcing hooks through Tools preserves the single-mutation-path property.

**Structural enforcement:** The handler signature passes the event as the first parameter and the `HookContext` as the second; the context exposes only the Vault's registered Tools, not the underlying filesystem. TypeScript types enforce this at compile time:

```ts
type HookHandler<E extends HookEvent = HookEvent> =
  (event: E, ctx: HookContext) => Promise<void>;

type HookContext = {
  tools: ReadonlyToolSurface;
  vault: { path: string };  // read-only metadata
};
```

The event payload (carrying `path`, `diff`, etc. depending on the event kind — see [[wiki/matrices/event-types-and-payloads]]) is the first argument; the context is purely the dispatcher-bound resources the handler may invoke. This keeps the seam clean: an `event` field on `HookContext` would imply the context is event-specific, which it is not.

No `fs` field, no `vault.write`, no raw write capability. Plugin authors who try to import `node:fs` directly cannot be statically prevented (they're untrusted code) but at runtime such writes are detected by the watcher: out-of-band writes against a Dome-managed vault trigger a `vault.out-of-band-edit` event, logged. `dome doctor` reports affected pages.

**Counter-example:** A "backup" plugin's hook on `document.written` calls `fs.writeFile('<vault>/.dome/backups/<file>', ...)`. Detected by watcher, logged, reported. The right design: register a `writeBackup` Tool the plugin's hook calls; the Tool's effects flow through the same logging and invariant infrastructure.

**Test guarantee:** `tests/invariants/hooks-cannot-bypass-tools.test.ts` — type-level test asserting `HookContext` has no filesystem access. Runtime test: a malicious hook that calls `fs.writeFile('wiki/entities/test.md', ...)` triggers a watcher event; the test asserts violation is logged and any written page is flagged by `dome doctor`.

**Related:**
- [[wiki/specs/hooks]]
- [[wiki/specs/sdk-surface]] §"Hook"
- [[wiki/gotchas/out-of-band-vault-edits]]
