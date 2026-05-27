// src/vault-dispatcher.ts
//
// wireDispatcher — extracts the dispatcher + cycle-listener wiring from
// openVault. The vaultRef setter pattern: closures hold a reference to a
// holder object (`{ current: Vault | null }`) rather than the Vault itself.
// This kills three hidden positional-ordering rules earlier openVault
// carried as inline comments (TDZ closure, "loadDeclarativeHooks LAST",
// cycle-listener wiring window) — per docs/wiki/specs/sdk-surface.md
// §"Composable construction".
//
// Construction order with vaultRef:
//
//   1. caller builds registry + privilegedWriter
//   2. caller declares `const vaultRef: VaultRef = { current: null }`
//   3. caller calls wireDispatcher(registry, writer, { vaultRef }) — returns
//      `dispatchEvents`, `drainHooks`, `close` closures BEFORE Vault exists
//   4. caller binds tools using those closures, assembles the Vault, then
//      assigns `vaultRef.current = vault`
//   5. caller may then call `dispatchEvents(...)`, which reads
//      `vaultRef.current` at call-time — the published Vault is observable
//
// `dispatchEvents` defensively no-ops if invoked before `vaultRef.current`
// is populated, matching the post-close no-op semantic (silent drop rather
// than dispatching into an uninitialized ctxFactory). In practice openVault
// publishes the Vault before any production caller can reach dispatchEvents,
// so the pre-publish branch is reachable only through tests that exercise
// the vaultRef setter pattern directly.

import { HookDispatcher } from "./hook-dispatcher";
import type { HookRegistry } from "./hook-registry";
import type { PrivilegedWriter } from "./privileged-writer";
import type { HookEvent } from "./hook-context";
import type { Vault, VaultConfig } from "./vault";
import { appendCycleLogEntry } from "./vault";

export interface VaultRef {
  current: Vault | null;
}

export interface WiredDispatcher {
  /** The underlying HookDispatcher — exposed for tests that need to inspect cycle wiring. */
  readonly dispatcher: HookDispatcher;
  /**
   * Project the given events through the hook dispatcher. Reads
   * `vaultRef.current` at call-time. No-ops after `close()` or before
   * `vaultRef.current` is populated.
   */
  dispatchEvents: (events: ReadonlyArray<HookEvent>) => Promise<void>;
  /**
   * Wait for the dispatcher's async queue AND any in-flight quarantine
   * persistence writes to settle. Idempotent.
   */
  drainHooks: () => Promise<void>;
  /**
   * One-shot. Drains hooks then flips an internal `closed` flag so subsequent
   * `dispatchEvents` calls silently no-op.
   */
  close: () => Promise<void>;
}

export interface WireDispatcherOpts {
  vaultRef: VaultRef;
  /**
   * Optional override for `HookDispatcher.maxCausationDepth`. When unset,
   * the dispatcher falls back to its own default (50). openVault passes
   * `config.hooks.max_causation_depth` here.
   */
  maxCausationDepth?: number;
}

/**
 * Build the dispatcher closures `openVault` exposes as Vault methods. The
 * `vaultRef` setter is the structural fence — closures never close over the
 * Vault directly. See module docstring above.
 */
export function wireDispatcher(
  registry: HookRegistry,
  writer: PrivilegedWriter,
  opts: WireDispatcherOpts,
): WiredDispatcher {
  const { vaultRef, maxCausationDepth } = opts;

  const dispatcher = new HookDispatcher(registry, {
    ...(maxCausationDepth !== undefined ? { maxCausationDepth } : {}),
  });

  // Wire cycle detection to log.md so `dome doctor --show recent-hook-cycles`
  // (which parses log.md for `hook.cycle-detected` entries) has a real
  // producer. Without this, the dispatcher detects cycles in-process but the
  // persistent record needed by a separate `dome doctor` process never
  // lands. The `appendLogEntry` privileged-writer surface is the right seam
  // because cycle events are dispatcher-owned per
  // INDEX_AND_LOG_ARE_DISPATCHER_OWNED.
  dispatcher.onCycleDetected((info) => {
    void appendCycleLogEntry(writer, info);
  });

  // dispatchEvents flips to no-op once close() is called. The flag is the
  // load-bearing v1+ seam for long-running mobile/desktop shells that open
  // and re-open Vaults — calls that accidentally outlive the Vault's
  // intended lifetime fail silently here rather than queueing events into
  // a dispatcher whose handlers may have since been freed.
  let closed = false;

  const dispatchEvents = async (events: ReadonlyArray<HookEvent>): Promise<void> => {
    if (closed) return;
    if (events.length === 0) return;
    const vault = vaultRef.current;
    // vaultRef is populated by openVault immediately after wireDispatcher
    // returns and before any production caller can reach this closure. The
    // null-guard is for test-shape symmetry with the post-close branch.
    if (vault === null) return;
    const ctxFactory = {
      baseCtx: { tools: vault.tools, vault: { path: vault.path } },
      privilegedWriter: writer,
    };
    await dispatcher.dispatchEvents(events, ctxFactory);
  };

  // drainHooks waits for both the dispatcher's async queue AND any in-flight
  // quarantine-persistence writes. The latter is load-bearing because dome
  // serve quarantining a handler on its final event needs the
  // .dome/state/quarantined.json write to land before the process exits.
  const drainHooks = async (): Promise<void> => {
    await dispatcher.drain();
    await registry.flushPersist();
  };

  // close() is one-shot per docs/wiki/specs/sdk-surface.md §"Vault lifecycle".
  const close = async (): Promise<void> => {
    await drainHooks();
    closed = true;
  };

  return { dispatcher, dispatchEvents, drainHooks, close };
}

// `VaultConfig` is re-exported via the openVault refactor in Task B4 to
// drive `maxCausationDepth` from `config.hooks.max_causation_depth`. The
// import remains here so the type is reachable via this module for v1+
// consumer surfaces that build their own dispatcher options.
export type { VaultConfig };
