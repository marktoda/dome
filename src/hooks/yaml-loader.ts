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
//
// Validation: the YAML shape is parsed by `DeclarativeHookSchema` (Zod)
// rather than hand-rolled typeof chains. `parseDeclarativeHook` returns a
// `Result<DeclarativeHook, ValidationError>` matching the Tool-surface
// Result<T, E> discipline. See docs/wiki/gotchas/boundary-validation-via-zod.md.

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { HookHandler, HookEvent, HookContext } from "../hook-context";
import type { HookRegistry } from "../hook-registry";
import type { Vault } from "../vault";
import { WORKFLOW_NAMES, type WorkflowName } from "../workflows/workflow-name";
import { ok, err, type Result } from "../types";

/**
 * Zod schema for the declarative-hook YAML shape. Lives next to the parser
 * because this loader is the only consumer — colocation makes the contract
 * obvious to the next reader. The workflow field is validated against the
 * canonical WORKFLOW_NAMES tuple so a typo in a YAML file fails fast with a
 * clear message rather than registering an inert handler.
 */
export const DeclarativeHookSchema = z.object({
  event: z.string(),
  path_pattern: z.string().optional(),
  workflow: z.enum(WORKFLOW_NAMES as readonly [WorkflowName, ...WorkflowName[]], {
    errorMap: (issue, ctx) => {
      if (issue.code === z.ZodIssueCode.invalid_enum_value) {
        return {
          message: `workflow '${String(issue.received)}' is not a known workflow name (one of: ${WORKFLOW_NAMES.join(", ")})`,
        };
      }
      return { message: ctx.defaultError };
    },
  }),
  async: z.boolean().optional(),
  idempotent: z.boolean().optional(),
});

/** Validated declarative-hook YAML shape (inferred from `DeclarativeHookSchema`). */
export type DeclarativeHook = z.infer<typeof DeclarativeHookSchema>;

/**
 * Persistence-boundary validation error. Shape mirrors `ToolError` from
 * `types.ts` (kind: "validation") so callers that compose Tool and loader
 * errors don't need a translation layer.
 */
export interface ValidationError {
  kind: "validation";
  path: string;
  message: string;
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
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (e: unknown) {
      opts.onLoadError?.(entry.name, (e as Error).message);
      continue;
    }
    const result = parseDeclarativeHook(text, entry.name);
    if (!result.ok) {
      opts.onLoadError?.(entry.name, result.error.message);
      continue;
    }
    const parsed = toRegistryEntry(result.value, entry.name);
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

/**
 * Parse and validate a declarative-hook YAML text. Returns a
 * `Result<DeclarativeHook, ValidationError>` rather than throwing — callers
 * (currently `loadDeclarativeHooks`) inspect the `ok` discriminant and
 * propagate the error.
 *
 * `sourcePath` is purely informational (filename appears in the error path);
 * the parser does no filesystem I/O. Tests instantiate raw YAML strings and
 * leave `sourcePath` defaulted.
 */
export function parseDeclarativeHook(
  yamlText: string,
  sourcePath = "",
): Result<DeclarativeHook, ValidationError> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return err({
      kind: "validation",
      path: sourcePath,
      message: `${sourcePath ? `${sourcePath}: ` : ""}YAML parse error: ${String(e)}`,
    });
  }
  const r = DeclarativeHookSchema.safeParse(raw);
  if (!r.success) {
    // Use the first issue's message for the human-readable form — Zod's
    // default `error.message` JSON-stringifies all issues which is too noisy
    // for the on-disk log entries and existing test assertions.
    const first = r.error.issues[0];
    const message = first
      ? `${sourcePath ? `${sourcePath}: ` : ""}${first.message}${first.path.length > 0 ? ` (at ${first.path.join(".")})` : ""}`
      : `${sourcePath ? `${sourcePath}: ` : ""}${r.error.message}`;
    return err({ kind: "validation", path: sourcePath, message });
  }
  return ok(r.data);
}

/**
 * Project a validated `DeclarativeHook` plus its source filename into the
 * shape `HookRegistry.register` consumes. Encapsulates the bare-event-to-
 * wildcard expansion and the .ya?ml-to-id stripping so `loadDeclarativeHooks`
 * stays a thin orchestration loop.
 */
function toRegistryEntry(hook: DeclarativeHook, filename: string): ParsedDeclarativeHook {
  const id = filename.replace(/\.ya?ml$/, "");
  // The substrate's example (hooks.md §"Declarative") uses `event:
  // document.written` as a coarse selector with `path_pattern: "inbox/raw/*"`
  // as the fine filter. Our hook-registry matcher requires an explicit `*`
  // for wildcard matching, so a bare `document.written` would only match
  // events with exactly that kind — never the projected `document.written.
  // inbox.raw`. Expand bare event strings to `<event>.*` for the registry
  // pattern; the path_pattern (matched in the handler) does the precise
  // narrowing. Events already containing `*` are honored verbatim.
  const registryPattern = hook.event.includes("*") ? hook.event : `${hook.event}.*`;
  const parsed: ParsedDeclarativeHook = {
    id,
    pattern: registryPattern,
    workflow: hook.workflow,
    async: hook.async ?? true,
    idempotent: hook.idempotent ?? true,
  };
  if (hook.path_pattern !== undefined) parsed.pathPattern = hook.path_pattern;
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
