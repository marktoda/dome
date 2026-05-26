import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { ok, err, type Result, type ToolError, type ToolReturn } from "./types";
import { isGitRepo } from "./git";
import { makePrivilegedWriter } from "./privileged-writer";
import { bindTools } from "./tools/registry";
import { HookRegistry } from "./hook-registry";
import { HookDispatcher } from "./hook-dispatcher";
import { autoUpdateIndex } from "./hooks/auto-update-index";
import { autoCrossReference } from "./hooks/auto-cross-reference";
import { loadDeclarativeHooks } from "./hooks/yaml-loader";
import { projectEffectsToEvents } from "./event-projection";
import type { BoundToolSurface, HookEvent } from "./hook-context";
import { SHIPPED_VAULT_CONFIG, SHIPPED_PAGE_TYPES } from "./shipped-defaults";

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
   * The AI SDK `ToolSet` curried against this Vault — the same Tools as
   * `tools`, just shaped for `generateText` consumption. `runWorkflow`
   * filters this to the workflow's declared subset; no separate construction
   * step. Adding an 8th Tool to the registry makes it available here for
   * free.
   */
  readonly aiTools: import("ai").ToolSet;
  /**
   * Per-Tool parse-and-invoke functions for transports that deliver raw
   * input (the MCP adapter, future HTTP/SSE surfaces). Each function parses
   * the input through its Zod schema, compacts the result, and invokes the
   * underlying Tool — sharing the same execution path the AI SDK consumer
   * uses. Keyed by canonical Tool name.
   */
  readonly toolParsers: Readonly<
    Record<import("./tools/registry").ToolName, (input: unknown) => Promise<import("./types").ToolReturn<unknown>>>
  >;
  /**
   * Wait for all async hooks dispatched so far to settle.
   * Built-in shipped-default hooks are async by default; tests and reconcile
   * call this to ensure deterministic state.
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
  const partial = { path: root, config, pageTypes } as Vault;


  // Hook wiring — shipped-default registrations gated by config.
  const registry = new HookRegistry();
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

  // dispatchEvents is the single entry point any subsystem (Tool wrap,
  // reconcile, watcher, declarative-hook handler) uses to push events
  // through the dispatcher. It assembles the ctxFactory once with the bound
  // tools surface; callers don't construct it.
  const dispatchEvents = async (events: ReadonlyArray<HookEvent>): Promise<void> => {
    if (events.length === 0) return;
    const ctxFactory = {
      baseCtx: { tools, vault: { path: root } },
      privilegedWriter,
    };
    await hookDispatcher.dispatchEvents(events, ctxFactory);
  };

  // Wrap mutating Tools so their effects flow through the hook dispatcher.
  // The registry tells `bindTools` which Tools mutate; read-only Tools
  // (`readDocument`, `searchIndex`, `wikilinkResolve`) are exposed unwrapped
  // (they emit no effects worth projecting).
  const wrapMutation = <I, R extends ToolReturn<unknown>>(
    fn: (input: I) => Promise<R>
  ) => async (input: I): Promise<R> => {
    const out = await fn(input);
    await dispatchEvents(projectEffectsToEvents(out.effects));
    return out;
  };

  const { tools, aiTools, parsers: toolParsers } = bindTools(partial, privilegedWriter, wrapMutation);

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
    aiTools,
    toolParsers,
    drainHooks: () => hookDispatcher.drain(),
    dispatchEvents,
    rebuildIndex,
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
