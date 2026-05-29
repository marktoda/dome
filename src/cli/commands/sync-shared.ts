// cli/commands/sync-shared: CLI-local helpers shared by sync/serve/etc.
//
// Engine host operations live in `src/engine/compiler-host.ts`; this module
// intentionally owns only command-surface helpers: resolving the SDK-shipped
// bundle directory and formatting verbose adoption events for stdout.

import { fileURLToPath } from "node:url";

import type { AdoptEvent } from "../../engine/compiler-host";

const processorGlobCache = new Map<string, Bun.Glob>();

/**
 * Returns the absolute path to the SDK's shipped first-party bundles
 * directory (`<SDK>/assets/extensions/`).
 *
 * Resolved relative to this module's location via `import.meta.url`, so
 * the math works regardless of where the user installed the SDK (global
 * `bun install -g`, local `node_modules`, `bun link` symlink, or a
 * `bun build`-produced single-file). From `src/cli/commands/sync-shared.ts`,
 * three directories up reaches the SDK package root; `assets/extensions/` is
 * the canonical shipped-bundles dir.
 */
export function resolveShippedBundlesRoot(): string {
  const url = new URL("../../../assets/extensions", import.meta.url);
  return fileURLToPath(url);
}

/**
 * Format an `AdoptEvent` as a single human-readable stdout line for
 * command-specific verbose output.
 */
export function formatAdoptEvent(
  event: AdoptEvent,
  opts: { readonly command: "serve" | "sync" },
): string {
  const prefix = `dome ${opts.command}:`;
  switch (event.kind) {
    case "iteration-start":
      return (
        `${prefix}   iteration ${event.iteration}: ` +
        `${event.changedPathCount} changed path${event.changedPathCount === 1 ? "" : "s"}, ` +
        `${event.signalCount} signal${event.signalCount === 1 ? "" : "s"}`
      );
    case "processor-result":
      return (
        `${prefix}     ↳ ${event.processorId}: ` +
        `${event.effectCount} effect${event.effectCount === 1 ? "" : "s"}`
      );
    case "iteration-end":
      return event.converged
        ? `${prefix}   iteration ${event.iteration}: converged`
        : `${prefix}   iteration ${event.iteration}: ` +
            `${event.autoPatchCount} auto-patch${event.autoPatchCount === 1 ? "" : "es"} accumulated → re-iterating`;
  }
}

/**
 * Format a verbose adoption event after applying the optional processor-id
 * filter. A processor filter intentionally includes only per-processor result
 * lines; iteration scaffolding is suppressed so filtered output stays focused.
 */
export function formatFilteredAdoptEvent(
  event: AdoptEvent,
  opts: {
    readonly command: "serve" | "sync";
    readonly processorFilter?: string | undefined;
  },
): string | null {
  const filter = opts.processorFilter;
  if (filter !== undefined) {
    if (event.kind !== "processor-result") return null;
    if (!processorIdMatches(filter, event.processorId)) return null;
  }
  return formatAdoptEvent(event, { command: opts.command });
}

function processorIdMatches(pattern: string, processorId: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern === processorId) return true;
  let glob = processorGlobCache.get(pattern);
  if (glob === undefined) {
    glob = new Bun.Glob(pattern);
    processorGlobCache.set(pattern, glob);
  }
  return glob.match(processorId);
}
