// Declarative-hook YAML loader. Reads <vault>/.dome/hooks/*.yaml and registers
// each as a hook whose handler invokes runWorkflow against the named workflow.
// Substrate: docs/wiki/specs/hooks.md §"Registration forms" §"Declarative".
//
// The YAML shape, per the spec:
//   event: document.written
//   path_pattern: "inbox/raw/*"     # optional filter on event.path
//   workflow: ingest                # name of a workflow-prompt
//   async: true                     # optional; default true
//   idempotent: true                # optional; default true
//
// This is what makes the shipped-default `intake-raw.yaml` actually fire when
// a file lands in `inbox/raw/`. Without this loader, intake YAMLs are inert
// files on disk.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { HookHandler, HookEvent, HookContext } from "../hook-context";
import type { HookRegistry } from "../hook-registry";
import type { Vault } from "../vault";
import { isWorkflowName, type WorkflowName } from "../workflows/workflow-name";

/** Declarative-hook YAML shape, validated by `parseDeclarativeHook`. */
export interface DeclarativeHookYaml {
  event: string;
  path_pattern?: string;
  workflow: WorkflowName;
  async?: boolean;
  idempotent?: boolean;
}

interface ParsedDeclarativeHook {
  id: string;
  pattern: string;
  pathPattern?: string;
  workflow: WorkflowName;
  async: boolean;
  idempotent: boolean;
}

/**
 * Optional override for the runWorkflow function the loader invokes from each
 * registered handler. Tests pass a stub here to capture invocations without
 * touching the LLM; production code (openVault) leaves it undefined, and the
 * loader lazy-imports the real runWorkflow (avoiding a runtime cycle with
 * `workflows/agent-loop.ts` — agent-loop imports Vault, vault.ts imports this
 * module, so going the other direction at runtime would loop).
 *
 * This shape is the test seam: previously the test suite used Bun's
 * `mock.module` to stub agent-loop globally, which polluted later-loaded
 * tests in the same process. An explicit injector is locality-friendly and
 * doesn't bleed across files.
 */
export type RunWorkflowFn = (
  vault: Vault,
  workflowName: WorkflowName,
  userMessage: string,
) => Promise<unknown>;

/**
 * Read every .yaml in <vault>/.dome/hooks/ and register a hook for each one.
 * The handler captures `vault` by closure and invokes `runWorkflow` with the
 * named workflow when the event fires. Lazy-imports `runWorkflow` to avoid
 * circular deps with `workflows/agent-loop.ts`; tests pass `opts.runWorkflow`
 * directly to stub out the LLM round-trip.
 *
 * Filenames whose YAML fails to parse are surfaced via `onLoadError`. The
 * loader does not throw; bad YAML simply doesn't register, the rest do.
 */
export async function loadDeclarativeHooks(
  vault: Vault,
  registry: HookRegistry,
  opts: {
    onLoadError?: (file: string, error: string) => void;
    runWorkflow?: RunWorkflowFn;
  } = {},
): Promise<void> {
  const hooksDir = join(vault.path, ".dome", "hooks");
  if (!existsSync(hooksDir)) return;
  const entries = await readdir(hooksDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".yaml") && !entry.name.endsWith(".yml")) continue;
    const filePath = join(hooksDir, entry.name);
    let parsed: ParsedDeclarativeHook;
    try {
      const text = await readFile(filePath, "utf8");
      parsed = parseDeclarativeHook(entry.name, text);
    } catch (e: unknown) {
      opts.onLoadError?.(entry.name, (e as Error).message);
      continue;
    }
    registry.register({
      id: `declarative:${parsed.id}`,
      pattern: parsed.pattern,
      source: "vault-local",
      async: parsed.async,
      idempotent: parsed.idempotent,
      handler: makeHandler(vault, parsed, opts.runWorkflow),
    });
  }
}

function parseDeclarativeHook(filename: string, text: string): ParsedDeclarativeHook {
  const raw = parseYaml(text) as Partial<DeclarativeHookYaml> | null;
  if (!raw || typeof raw !== "object") throw new Error(`${filename}: empty or non-object YAML`);
  if (typeof raw.event !== "string") throw new Error(`${filename}: missing or non-string 'event'`);
  if (typeof raw.workflow !== "string") throw new Error(`${filename}: missing or non-string 'workflow'`);
  if (!isWorkflowName(raw.workflow)) {
    throw new Error(`${filename}: workflow '${raw.workflow}' is not a known workflow name`);
  }
  if (raw.path_pattern !== undefined && typeof raw.path_pattern !== "string") {
    throw new Error(`${filename}: path_pattern must be a string if present`);
  }
  const id = filename.replace(/\.ya?ml$/, "");
  // The substrate's example (hooks.md §"Declarative") uses `event:
  // document.written` as a coarse selector with `path_pattern: "inbox/raw/*"`
  // as the fine filter. Our hook-registry matcher requires an explicit `*`
  // for wildcard matching, so a bare `document.written` would only match
  // events with exactly that kind — never the projected `document.written.
  // inbox.raw`. Expand bare event strings to `<event>.*` for the registry
  // pattern; the path_pattern (matched in the handler) does the precise
  // narrowing. Events already containing `*` are honored verbatim.
  const registryPattern = raw.event.includes("*") ? raw.event : `${raw.event}.*`;
  const parsed: ParsedDeclarativeHook = {
    id,
    pattern: registryPattern,
    workflow: raw.workflow,
    async: raw.async ?? true,
    idempotent: raw.idempotent ?? true,
  };
  if (raw.path_pattern !== undefined) parsed.pathPattern = raw.path_pattern;
  return parsed;
}

function makeHandler(
  vault: Vault,
  parsed: ParsedDeclarativeHook,
  injectedRunWorkflow: RunWorkflowFn | undefined,
): HookHandler {
  return async (event: HookEvent, _ctx: HookContext) => {
    if (parsed.pathPattern !== undefined) {
      const path = typeof event.path === "string" ? event.path : "";
      if (!matchPathPattern(parsed.pathPattern, path)) return;
    }
    // Use the injected runWorkflow (tests) or lazy-import the real one
    // (production). Lazy-import avoids the circular dep — this module is
    // imported eagerly by vault.ts; agent-loop.ts depends on WorkflowRegistry
    // which depends on Vault.
    const run = injectedRunWorkflow ?? (await import("../workflows/agent-loop")).runWorkflow;
    const eventPath = typeof event.path === "string" ? event.path : "(none)";
    const userMessage =
      `An ${event.kind} event was observed at path ${eventPath}. Process it per your workflow.`;
    await run(vault, parsed.workflow, userMessage);
  };
}

// Glob match for `inbox/raw/*` style path patterns. Conservative: only `*` as
// a path segment is supported (matches anything that isn't a slash); no `**`.
// Matches the substrate's example shape; a full glob lib (minimatch) is v1.
function matchPathPattern(pattern: string, path: string): boolean {
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$",
  );
  return re.test(path);
}
