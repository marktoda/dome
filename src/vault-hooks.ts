// src/vault-hooks.ts
//
// buildBuiltinHookRegistry — extracts the shipped-default hook registration
// loop from openVault. Constructs a HookRegistry and registers the built-in
// handlers per `.dome/config.yaml.hooks.builtin.*` flags. See
// docs/wiki/specs/sdk-surface.md §"Composable construction".
//
// Two notes on shape:
//
//  1. The HookRegistry needs a persistent quarantine record at
//     `.dome/state/quarantined.json` so handlers quarantined in one CLI
//     invocation are still skipped on the next (dome doctor and dome serve
//     do not share a process). The factory loads the existing record from
//     disk before constructing the registry — the same async-then-sync
//     pattern openVault has historically used.
//
//  2. The factory is async because of the quarantine pre-load. The spec
//     example in sdk-surface.md shows a synchronous return for brevity;
//     the actual implementation must be async to surface the disk read.

import { join } from "node:path";
import { HookRegistry } from "./hook-registry";
import { autoUpdateIndex } from "./hooks/auto-update-index";
import { autoCrossReference } from "./hooks/auto-cross-reference";
import { logOutOfBandWrite } from "./hooks/log-out-of-band-write";
import { makeQuarantineStore } from "./quarantine-store";
import type { VaultConfig } from "./vault";

/**
 * Build the shipped-default hook registry for a vault at `root`. Reads the
 * persisted quarantine record at `.dome/state/quarantined.json` and registers
 * each built-in handler whose flag is "enabled" in `config.hooks.builtin`.
 *
 * The registration ordering mirrors openVault verbatim so the resulting
 * `registry.list()` is identical and the dispatcher's iteration order
 * matches the prior shape.
 */
export async function buildBuiltinHookRegistry(root: string, config: VaultConfig): Promise<HookRegistry> {
  const quarantinePath = join(root, ".dome", "state", "quarantined.json");
  const initialQuarantined = await makeQuarantineStore(quarantinePath).load();
  const registry = new HookRegistry({ persistPath: quarantinePath, initialQuarantined });
  if (config.hooks.builtin["auto-update-index"] === "enabled") {
    registry.register({
      id: "auto-update-index-write",
      pattern: "document.written.wiki.*",
      handler: autoUpdateIndex,
      source: "sdk",
      async: true,
      idempotent: true,
    });
    registry.register({
      id: "auto-update-index-delete",
      pattern: "document.deleted.wiki.*",
      handler: autoUpdateIndex,
      source: "sdk",
      async: true,
      idempotent: true,
    });
    // Watcher path: native wiki edits caught by chokidar must also update
    // index.md per VAULT_RECONCILES_AFTER_NATIVE_WRITE.md §"Structural
    // enforcement" path 1. The handler filters to wiki/ paths and
    // discriminates fsKind ("deleted" → removeIndexEntry; else writeIndex).
    registry.register({
      id: "auto-update-index-oob",
      pattern: "vault.out-of-band-edit",
      handler: autoUpdateIndex,
      source: "sdk",
      async: true,
      idempotent: true,
    });
  }
  if (config.hooks.builtin["auto-cross-reference"] === "enabled") {
    registry.register({
      id: "auto-cross-reference",
      pattern: "document.written.wiki.entity",
      handler: autoCrossReference,
      source: "sdk",
      async: true,
      idempotent: true,
    });
  }
  if (config.hooks.builtin["log-out-of-band-write"] === "enabled") {
    // Watcher path only: live OOB edits caught by chokidar fire
    // vault.out-of-band-edit (a unique kind no other code path emits).
    // The reconcile path enforces EVERY_WRITE_IS_LOGGED separately — see
    // src/reconcile.ts phase-2, which calls vault.tools.appendLog directly
    // per replayed file. Subscribing this hook to document.written.wiki.*
    // would also catch Tool-mediated writes (they project to the same
    // event kind), producing duplicate spurious "out-of-band" log entries.
    // See docs/wiki/invariants/VAULT_RECONCILES_AFTER_NATIVE_WRITE.md.
    registry.register({
      id: "log-out-of-band-write",
      pattern: "vault.out-of-band-edit",
      handler: logOutOfBandWrite,
      source: "sdk",
      async: true,
      idempotent: true,
    });
  }
  return registry;
}
