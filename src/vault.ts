import { existsSync } from "node:fs";
import { join } from "node:path";
import { ok, err, type Result, type ToolError } from "./types";
import { isGitRepo } from "./git";
import { walkUpForAncestor } from "./path-walk";
import { makePrivilegedWriter, type PrivilegedWriter } from "./privileged-writer";
import { bindTools } from "./tools/registry";
import { type CycleInfo } from "./hooks/hook-dispatcher";
import { loadDeclarativeHooks } from "./hooks/yaml-loader";
import type { BoundToolSurface, HookEvent } from "./hooks/hook-context";
import { loadVaultConfig } from "./vault-config";
import { buildBuiltinHookRegistry } from "./vault-hooks";
import { wireDispatcher, type VaultRef } from "./vault-dispatcher";

export interface VaultConfig {
  invariants: Record<string, "enabled" | "disabled">;
  hooks: {
    builtin: Record<string, "enabled" | "disabled">;
    max_causation_depth: number;
    /**
     * Threshold for the dome doctor INBOX_IS_EPHEMERAL fallback check.
     * Files in `inbox/<bucket>/` (excluding `inbox/review/`) older than this
     * many hours emit a violation. Set arbitrarily high to disable the check
     * effectively; per-bucket disable is deferred to v0.5.1+ per the invariant
     * doc. See docs/wiki/invariants/INBOX_IS_EPHEMERAL.md.
     */
    inbox_stale_age_hours: number;
  };
  git: {
    auto_commit_workflows: boolean;
  };
}

export interface PageTypesConfig {
  defaults: ReadonlyArray<string>;
  extensions: ReadonlyArray<string | { name: string; frontmatter_extras?: Record<string, unknown> }>;
}

// BoundToolSurface is the single canonical shape of "the seven Tools curried
// with their Vault" and lives in hook-context.ts. Re-exported here so existing
// `import { BoundToolSurface } from "./vault"` callers continue to work.
export type { BoundToolSurface } from "./hooks/hook-context";

export interface Vault {
  readonly path: string;
  readonly config: VaultConfig;
  readonly pageTypes: PageTypesConfig;
  readonly tools: BoundToolSurface;
  /**
   * Wait for all async hooks dispatched so far AND any in-flight quarantine
   * persistence writes to settle. Idempotent — re-callable any number of times.
   * Tests, `dome reconcile`, and `vault.close()` call this to reach a
   * deterministic state.
   */
  drainHooks: () => Promise<void>;
  /**
   * Project the given events through the vault's hook dispatcher. Used by
   * `reconcile` (phase 1 inbox scan, phase 2 git-diff replay, phase 3
   * scheduled catchup) and `VaultWatcher` (out-of-band edits) to drive the
   * declarative-hook YAML loader's registrations. Without this seam, every
   * caller of those subsystems has to assemble the ctxFactory themselves.
   */
  dispatchEvents: (events: ReadonlyArray<HookEvent>) => Promise<void>;
  /**
   * Regenerate `index.md` by walking every wiki page and writing one
   * privileged-writer entry per file. Used by `dome doctor --rebuild-index`
   * and by any consumer that needs a from-scratch rebuild (e.g., after the
   * auto-update-index hook was disabled and the index drifted).
   *
   * Privileged write — internally consults the PrivilegedWriter the Vault
   * holds. Consumers that need this behavior call this method rather than
   * reaching into the writer, which is intentionally not exported.
   */
  rebuildIndex: () => Promise<void>;
  /**
   * Release the Vault. One-shot. Drains hooks and any in-flight quarantine
   * persistence; releases Vault-owned resources (the p-queue inside
   * HookDispatcher; any file handles held by the quarantine-store factory).
   *
   * Watchers are caller-owned and NOT stopped by this call — even ones that
   * were dispatching into vault.dispatchEvents(...). The caller-owns-resource
   * pattern mirrors Bun's file handles: whoever opened it, closes it.
   *
   * Calling vault.tools.X after close() is undefined behavior in v0.5; future
   * versions may add a guard. See docs/wiki/specs/sdk-surface.md
   * §"Vault lifecycle".
   */
  close: () => Promise<void>;
  /**
   * @internal — consumed by `projectAiSdk` to bind AI-SDK Tool execute
   * handlers to the same PrivilegedWriter `openVault` already constructed.
   * Do NOT consume from plugin code. The INDEX_AND_LOG_ARE_DISPATCHER_OWNED
   * axiom is preserved: plugin code reaches the privileged writer ONLY via
   * `HookContext.privilegedWriter`, which the dispatcher partitions to
   * sdk-source hooks. This field is module-private optimization for the
   * in-SDK `projectAiSdk(vault)` caller; it is NOT re-exported from
   * `src/index.ts` (no `PrivilegedWriter` type export), so plugin authors
   * cannot reach it through the public surface.
   */
  readonly _writer: PrivilegedWriter;
}

/**
 * Format a CycleInfo into a `log.md` `hook.cycle-detected` entry and persist
 * it via the privileged writer. Exported so its shape can be unit-tested
 * without driving a real cycle through the dispatcher (which requires
 * programmatic-hook registration, deferred to v0.5.1+). `openVault` wires
 * this from `hookDispatcher.onCycleDetected` so production cycles produce
 * the persistent record `dome doctor --show recent-hook-cycles` parses.
 */
export async function appendCycleLogEntry(
  writer: PrivilegedWriter,
  info: CycleInfo,
): Promise<void> {
  await writer.appendLogEntry({
    ts: new Date().toISOString(),
    verb: "hook.cycle-detected",
    subject: `handler=${info.triggeringHandler} depth=${info.depth}`,
    body: info.chain.length > 0
      ? `chain:\n${info.chain.map((l, i) => `  ${i}. ${l.handlerId} -> ${l.targetPath}`).join("\n")}`
      : "",
  });
}

async function findVaultRoot(start: string): Promise<string | null> {
  return walkUpForAncestor(start, (dir) => existsSync(join(dir, ".dome", "config.yaml")));
}

/**
 * Open a vault rooted at (or above) `path`. The body composes three helpers
 * — `loadVaultConfig`, `buildBuiltinHookRegistry`, `wireDispatcher` — and
 * publishes the assembled Vault into a `VaultRef` so dispatcher closures
 * read it lazily. The three positional-ordering rules earlier carried as
 * inline comments (TDZ closure on `tools`, "loadDeclarativeHooks LAST",
 * cycle-listener wiring window) collapse into one explicit step:
 * `vaultRef.current = vault` after closures are constructed.
 *
 * A future v1+ consumer surface (desktop/voice/HTTP) that wants a custom
 * subset of the built-in Vault behavior assembles from the three helpers
 * independently rather than forking openVault. See
 * docs/wiki/specs/sdk-surface.md §"Composable construction".
 */
export async function openVault(path: string): Promise<Result<Vault, ToolError>> {
  const root = await findVaultRoot(path);
  if (root === null) {
    return err({ kind: "config-invalid", message: `No .dome/config.yaml found at or above ${path}` });
  }
  if (!(await isGitRepo(root))) {
    return err({ kind: "vault-not-git-repo", path: root });
  }

  const configResult = await loadVaultConfig(root);
  if (!configResult.ok) return configResult;
  const { config, pageTypes } = configResult.value;

  // PrivilegedWriter is INTERNAL — not exposed on Vault and not exported
  // from src/index.ts (the structural enforcement layer for
  // INDEX_AND_LOG_ARE_DISPATCHER_OWNED). It reaches built-in hooks via
  // HookContext.privilegedWriter; plugins never see it.
  const privilegedWriter = makePrivilegedWriter(root);

  // Shipped-default hook registry — pre-loads the persisted quarantine
  // record at .dome/state/quarantined.json so handlers quarantined during
  // one CLI invocation are still skipped on the next (dome doctor and
  // dome serve don't share a process).
  const registry = await buildBuiltinHookRegistry(root, config);

  // Wire dispatcher closures via the vaultRef setter pattern. Closures hold
  // a reference to `vaultRef` rather than the Vault itself; they read
  // `vaultRef.current` at call-time, so they can be constructed before the
  // Vault object exists. dispatchEvents defensively no-ops if invoked
  // before `vaultRef.current` is populated (in practice openVault publishes
  // the Vault before any production caller can reach the closure).
  const vaultRef: VaultRef = { current: null };
  const { dispatchEvents, drainHooks, close } = wireDispatcher(registry, privilegedWriter, {
    vaultRef,
    maxCausationDepth: config.hooks.max_causation_depth,
  });

  // The hook-dispatch wrap is intrinsic to bindTools via wrapMutatingInvoke:
  // it reads `vault.dispatchEvents` from the partial we hand in, and every
  // projection of vault.tools (bindAiSdkTools, renderMcp, future renderHttp /
  // renderVoice) consumes the same single-source helper. See
  // HOOK_DISPATCH_IS_VAULT_BOUND.
  //
  // Only the strict-input BoundToolSurface is held on Vault. The AI-SDK
  // ToolSet and per-Tool parsers used to live on Vault.aiTools / .toolParsers;
  // they now live in entrypoint-scoped projectAiSdk(vault) (in
  // @dome/sdk/workflows) and renderMcp(buildAbstractSurface(vault)) (in
  // @dome/sdk/mcp) — this is what makes CORE_HAS_NO_LLM_OR_MCP_DEPENDENCY
  // structurally true: openVault no longer needs to import `ai` to
  // construct aiTools eagerly.
  const partial = { path: root, config, pageTypes, dispatchEvents } as Vault;
  const { tools } = bindTools(partial, privilegedWriter);

  // Walk wiki/ and rewrite index.md from scratch via the privileged writer.
  // Exposed as `vault.rebuildIndex()` so the CLI's `dome doctor --rebuild-index`
  // and other consumers (mobile rebuild button, voice "regenerate my index")
  // don't reach into privileged-writer.ts.
  const rebuildIndex = async (): Promise<void> => {
    const { walkMd } = await import("./vault-fs");
    const { join, relative, basename } = await import("node:path");
    for await (const filePath of walkMd(join(root, "wiki"))) {
      const rel = relative(root, filePath);
      const title = basename(filePath).replace(/\.md$/, "");
      await privilegedWriter.writeIndex({ path: rel, title });
    }
  };

  const vault: Vault = {
    path: root,
    config,
    pageTypes,
    tools,
    drainHooks,
    dispatchEvents,
    rebuildIndex,
    close,
    _writer: privilegedWriter,
  };

  // Publish the assembled Vault into vaultRef BEFORE loadDeclarativeHooks so
  // any handler that fires through dispatchEvents during the load sees a
  // real Vault. This single step replaces three earlier positional-ordering
  // rules (TDZ closure on `tools`, "loadDeclarativeHooks LAST", cycle-
  // listener wiring window) — see the function docstring.
  vaultRef.current = vault;

  // Declarative hook YAMLs — order within this step is free now that the
  // Vault is published. Errors are surfaced as appendLog entries; one bad
  // YAML doesn't kill the rest of the load.
  await loadDeclarativeHooks(vault, registry, {
    onLoadError: (file, message) => {
      void privilegedWriter.appendLogEntry({
        ts: new Date().toISOString(),
        verb: "hook-load-failed",
        subject: `declarative hook ${file} failed to load`,
        body: message,
      });
    },
  });

  return ok(vault);
}
