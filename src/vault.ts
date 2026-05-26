import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError } from "./types";
import { isGitRepo } from "./git";
import { makePrivilegedWriter, type PrivilegedWriter } from "./privileged-writer";
import { bindTools } from "./tools/registry";
import { HookRegistry } from "./hook-registry";
import { HookDispatcher, type CycleInfo } from "./hook-dispatcher";
import { autoUpdateIndex } from "./hooks/auto-update-index";
import { autoCrossReference } from "./hooks/auto-cross-reference";
import { loadDeclarativeHooks } from "./hooks/yaml-loader";
import type { BoundToolSurface, HookEvent } from "./hook-context";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "./shipped-defaults";
import { makeQuarantineStore } from "./quarantine-store";

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
export type { BoundToolSurface } from "./hook-context";

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
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".dome", "config.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function openVault(path: string): Promise<Result<Vault, ToolError>> {
  const root = await findVaultRoot(path);
  if (root === null) {
    return err({ kind: "config-invalid", message: `No .dome/config.yaml found at or above ${path}` });
  }
  if (!(await isGitRepo(root))) {
    return err({ kind: "vault-not-git-repo", path: root });
  }
  let config: VaultConfig = SHIPPED_VAULT_CONFIG;
  let pageTypes: PageTypesConfig = SHIPPED_PAGE_TYPES;
  try {
    const cfgText = await readFile(join(root, ".dome", "config.yaml"), "utf8");
    const parsed = parseYaml(cfgText) as Partial<VaultConfig>;
    config = { ...SHIPPED_VAULT_CONFIG, ...parsed,
      invariants: { ...SHIPPED_VAULT_CONFIG.invariants, ...(parsed.invariants ?? {}) },
      hooks: { ...SHIPPED_VAULT_CONFIG.hooks, ...(parsed.hooks ?? {}),
        builtin: { ...SHIPPED_VAULT_CONFIG.hooks.builtin, ...((parsed.hooks?.builtin) ?? {}) } },
      git: { ...SHIPPED_VAULT_CONFIG.git, ...(parsed.git ?? {}) },
    };
  } catch (e: unknown) {
    return err({ kind: "config-invalid", message: `Failed to parse .dome/config.yaml: ${(e as Error).message}` });
  }
  try {
    const ptText = await readFile(join(root, ".dome", "page-types.yaml"), "utf8");
    const parsed = parseYaml(ptText) as Partial<PageTypesConfig>;
    pageTypes = { ...SHIPPED_PAGE_TYPES, ...parsed };
  } catch {
    // page-types is optional
  }
  // PrivilegedWriter is INTERNAL — not exposed on Vault and not exported
  // from src/index.ts (the structural enforcement layer for
  // INDEX_AND_LOG_ARE_DISPATCHER_OWNED). It reaches built-in hooks via
  // HookContext.privilegedWriter; plugins never see it.
  const privilegedWriter = makePrivilegedWriter(root);

  // Hook wiring — shipped-default registrations gated by config. The registry
  // gets a persistent quarantine record at .dome/state/quarantined.json so
  // handlers quarantined during one CLI invocation are still skipped on the
  // next (dome doctor and dome serve don't share a process).
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
  const hookDispatcher = new HookDispatcher(registry, {
    maxCausationDepth: config.hooks.max_causation_depth,
  });
  // Wire cycle detection to log.md so `dome doctor --show recent-hook-cycles`
  // (which parses log.md for `hook.cycle-detected` entries) has a real producer.
  // Without this, the dispatcher detects cycles in-process but the persistent
  // record needed by a separate `dome doctor` process never lands. The
  // `appendLogEntry` privileged-writer surface is the right seam because cycle
  // events are dispatcher-owned per INDEX_AND_LOG_ARE_DISPATCHER_OWNED.
  hookDispatcher.onCycleDetected((info) => {
    void appendCycleLogEntry(privilegedWriter, info);
  });

  // dispatchEvents is the single entry point any subsystem (Tool wrap,
  // reconcile, watcher, declarative-hook handler) uses to push events
  // through the dispatcher. It assembles the ctxFactory once with the bound
  // tools surface; callers don't construct it. `tools` is `const`-declared
  // below; the closure reads it lazily at dispatch time, by which point
  // bindTools has assigned it.
  //
  // After vault.close() flips `closed`, dispatchEvents becomes a no-op:
  // it accepts no new work. drainHooks remains callable (idempotent), and
  // existing in-flight events still complete (drain awaits them before
  // close returns). The flag is the load-bearing v1+ seam for long-running
  // mobile/desktop shells that open and re-open Vaults — calls that
  // accidentally outlive the Vault's intended lifetime fail silently here
  // rather than queueing events into a dispatcher whose handlers may have
  // since been freed.
  let closed = false;
  const dispatchEvents = async (events: ReadonlyArray<HookEvent>): Promise<void> => {
    if (closed) return;
    if (events.length === 0) return;
    const ctxFactory = {
      baseCtx: { tools, vault: { path: root } },
      privilegedWriter,
    };
    await hookDispatcher.dispatchEvents(events, ctxFactory);
  };

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

  // drainHooks waits for both the dispatcher's async queue AND any
  // in-flight quarantine-persistence writes. The latter is load-bearing
  // because dome serve quarantining a handler on its final event needs
  // the .dome/state/quarantined.json write to land before the process
  // exits — otherwise dome doctor on the next CLI invocation sees an
  // empty quarantine and the failing handler re-fires. The contract
  // ("quarantine survives across processes") in hooks.md §"Execution
  // model" Failure model depends on both drains completing.
  const drainHooks = async (): Promise<void> => {
    await hookDispatcher.drain();
    await registry.flushPersist();
  };

  // close() is one-shot per docs/wiki/specs/sdk-surface.md §"Vault lifecycle".
  // Drains hooks (settles the p-queue + flushPersist), then flips the
  // `closed` flag so dispatchEvents stops accepting new work. Watchers are
  // caller-owned and not stopped here — even ones that were dispatching
  // into vault.dispatchEvents(...) — but their dispatches now no-op.
  const close = async (): Promise<void> => {
    await drainHooks();
    closed = true;
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
  };

  // Load declarative hook YAMLs LAST — after the vault is fully constructed —
  // so the handlers can close over the live `vault` reference for runWorkflow.
  // Errors are surfaced as appendLog entries; one bad YAML doesn't kill the
  // rest of the load.
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
