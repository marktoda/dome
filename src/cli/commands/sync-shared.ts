// cli/commands/sync-shared: CLI-local helpers shared by sync/serve/etc.
//
// Engine host operations live in `src/engine/compiler-host.ts`; this module
// intentionally owns only command-surface helpers: resolving the SDK-shipped
// bundle directory and formatting verbose adoption events for stdout.

import { fileURLToPath } from "node:url";

import type { AdoptEvent } from "../../engine/compiler-host";

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
 * `dome serve --verbose` / `dome sync --verbose`.
 */
export function formatAdoptEvent(event: AdoptEvent): string {
  switch (event.kind) {
    case "iteration-start":
      return (
        `dome serve:   iteration ${event.iteration}: ` +
        `${event.changedPathCount} changed path${event.changedPathCount === 1 ? "" : "s"}, ` +
        `${event.signalCount} signal${event.signalCount === 1 ? "" : "s"}`
      );
    case "processor-result":
      return (
        `dome serve:     ↳ ${event.processorId}: ` +
        `${event.effectCount} effect${event.effectCount === 1 ? "" : "s"}`
      );
    case "iteration-end":
      return event.converged
        ? `dome serve:   iteration ${event.iteration}: converged`
        : `dome serve:   iteration ${event.iteration}: ` +
            `${event.autoPatchCount} auto-patch${event.autoPatchCount === 1 ? "" : "es"} accumulated → re-iterating`;
  }
}
