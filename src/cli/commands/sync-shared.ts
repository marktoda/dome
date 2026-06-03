// cli/commands/sync-shared: CLI-local helpers shared by sync/serve/etc.
//
// Engine host operations live in `src/engine/compiler-host.ts`; this module
// intentionally owns only command-surface helpers: resolving the SDK-shipped
// bundle directory, composing the default vault-local extension root, and
// formatting verbose adoption events for stdout.

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AdoptEvent } from "../../engine/compiler-host";
import type { GardenPhaseResult } from "../../engine/garden";
import type { OperationalWorkResult } from "../../engine/operational-work";
import {
  headline,
  kv,
  resolveCaps,
  section,
  type KvRow,
} from "../presenter";

const processorGlobCache = new Map<string, Bun.Glob>();

export type ResolvedBundleRoots = {
  readonly bundlesRoot: string;
  readonly additionalBundlesRoots?: ReadonlyArray<string>;
};

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

export function resolveVaultLocalBundlesRoot(vaultPath: string): string {
  return join(vaultPath, ".dome", "extensions");
}

/**
 * Resolve bundle roots for normal CLI/runtime use. An explicit
 * `--bundles-root` remains an exact override for tests and ad-hoc dev. The
 * default path composes SDK-shipped bundles with an existing vault-local
 * `.dome/extensions/` root, with vault-local bundles taking precedence.
 */
export function resolveBundleRoots(opts: {
  readonly vaultPath: string;
  readonly bundlesRoot?: string | undefined;
}): ResolvedBundleRoots {
  if (opts.bundlesRoot !== undefined) {
    return Object.freeze({
      bundlesRoot: resolve(opts.bundlesRoot),
    });
  }

  const shipped = resolveShippedBundlesRoot();
  const local = resolveVaultLocalBundlesRoot(opts.vaultPath);
  if (!existsSync(local)) {
    return Object.freeze({ bundlesRoot: shipped });
  }
  return Object.freeze({
    bundlesRoot: shipped,
    additionalBundlesRoots: Object.freeze([local]),
  });
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

export function printHostFollowupLines(
  command: "dome serve" | "dome sync",
  garden: GardenPhaseResult | null,
  operational: OperationalWorkResult | null,
  context?: string,
): void {
  const caps = resolveCaps();
  // Extract the subcommand after "dome " for the presenter headline.
  const cmd = command.slice("dome ".length) as "serve" | "sync";
  const headlineLeft =
    context !== undefined ? { cmd, context } : { cmd };

  if (
    garden !== null &&
    (garden.subProposalCount > 0 ||
      garden.rejectedPatchCount > 0 ||
      garden.diagnostics.length > 0)
  ) {
    const gardenRows: KvRow[] = [
      { label: "sub-proposals", value: `${garden.subProposalCount}` },
      { label: "rejected patches", value: `${garden.rejectedPatchCount}` },
      { label: "diagnostics", value: `${garden.diagnostics.length}` },
    ];
    const lines: string[] = [
      headline(headlineLeft, { tone: "plain", label: "garden follow-up" }, caps),
      ...section("Garden", kv(gardenRows, caps), caps),
    ];
    const text = ["", ...lines].join("\n");
    if (garden.rejectedPatchCount > 0 || garden.diagnostics.length > 0) {
      console.error(text);
    } else {
      console.log(text);
    }
  }

  if (
    operational !== null &&
    (operational.scheduler.fired.length > 0 ||
      operational.jobs.drained.length > 0 ||
      operational.outbox.length > 0 ||
      operational.questionAutoResolution.answered > 0 ||
      operational.diagnostics.length > 0)
  ) {
    const opRows: KvRow[] = [
      { label: "scheduled", value: `${operational.scheduler.fired.length}` },
      { label: "jobs", value: `${operational.jobs.drained.length}` },
      { label: "outbox", value: `${operational.outbox.length}` },
      { label: "auto-resolved", value: `${operational.questionAutoResolution.answered}` },
      { label: "diagnostics", value: `${operational.diagnostics.length}` },
    ];
    const lines: string[] = [
      headline(headlineLeft, { tone: "plain", label: "operational work" }, caps),
      ...section("Operational", kv(opRows, caps), caps),
    ];
    const text = ["", ...lines].join("\n");
    if (operational.diagnostics.length > 0) {
      console.error(text);
    } else {
      console.log(text);
    }
  }
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
