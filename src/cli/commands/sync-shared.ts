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
import type { DiagnosticEffect } from "../../core/effect";
import {
  type Caps,
  glyph,
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

/** Severities most-severe-first, so the breakdown leads with what matters. */
const SEVERITY_ORDER = ["block", "error", "warning", "info"] as const;

/**
 * Default number of active processor ids shown inline on the adopted line
 * before collapsing the tail into `+N more`. Keeps the one-liner readable
 * on a vault with a dozen processors while still naming the ones that did
 * the work.
 */
const DEFAULT_MAX_PROCESSORS = 4;

/**
 * Build the operator-facing one-line adoption summary, e.g.
 *
 *   dome serve: adopted main 84b81a3 · 2 iterations · 12 diagnostics (3 warning, 9 info) · ran dome.graph, dome.markdown
 *
 * The diagnostic severity breakdown (most-severe-first, zero buckets
 * omitted) turns the bare count into a sense of *what kind* of findings
 * surfaced; the `ran …` tail names the adoption-phase processors that
 * actually emitted effects this tick, so the operator sees *which*
 * improvements landed without reaching for `dome inspect`. The separator
 * is the caps-aware `sep` glyph (`·` unicode, `-` ascii).
 */
export function formatAdoptedSummaryLine(
  input: {
    readonly command: "serve" | "sync";
    readonly branch: string;
    readonly adoptedRef: string;
    readonly iterations: number;
    readonly diagnostics: ReadonlyArray<DiagnosticEffect>;
    readonly activeProcessorIds: ReadonlyArray<string>;
  },
  caps: Caps,
  opts?: { readonly maxProcessors?: number },
): string {
  const sep = ` ${glyph("sep", caps)} `;
  const iters = input.iterations;
  const diagCount = input.diagnostics.length;

  const parts: string[] = [
    `${input.iterations} iteration${iters === 1 ? "" : "s"}`,
  ];

  let diagPart = `${diagCount} diagnostic${diagCount === 1 ? "" : "s"}`;
  const breakdown = formatSeverityBreakdown(input.diagnostics);
  if (breakdown !== null) diagPart += ` (${breakdown})`;
  parts.push(diagPart);

  const processorPart = formatActiveProcessors(
    input.activeProcessorIds,
    opts?.maxProcessors ?? DEFAULT_MAX_PROCESSORS,
  );
  if (processorPart !== null) parts.push(processorPart);

  return (
    `dome ${input.command}: adopted ${input.branch} ` +
    `${input.adoptedRef.slice(0, 7)}${sep}${parts.join(sep)}`
  );
}

/**
 * Render a `<count> <severity>` breakdown for the non-empty severity
 * buckets, most-severe-first. Returns `null` when there are no diagnostics
 * (the caller shows the bare count instead).
 */
function formatSeverityBreakdown(
  diagnostics: ReadonlyArray<DiagnosticEffect>,
): string | null {
  if (diagnostics.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of diagnostics) {
    counts.set(d.severity, (counts.get(d.severity) ?? 0) + 1);
  }
  const segments = SEVERITY_ORDER.filter((s) => (counts.get(s) ?? 0) > 0).map(
    (s) => `${counts.get(s)} ${s}`,
  );
  return segments.length > 0 ? segments.join(", ") : null;
}

/**
 * Render the `ran a, b, c [+N more]` tail naming the processors that did
 * work this tick. Ids are sorted for determinism and capped at `max`.
 * Returns `null` when no processor was active.
 */
function formatActiveProcessors(
  processorIds: ReadonlyArray<string>,
  max: number,
): string | null {
  if (processorIds.length === 0) return null;
  const sorted = [...processorIds].sort();
  const shown = sorted.slice(0, max);
  const overflow = sorted.length - shown.length;
  const tail = overflow > 0 ? ` +${overflow} more` : "";
  return `ran ${shown.join(", ")}${tail}`;
}

/**
 * The sorted, de-duplicated processor ids whose garden runs emitted at
 * least one effect. This is the post-adoption analogue of the adopted
 * line's `ran …` tail: it names *which* garden processors produced the
 * sub-Proposals / facts reported by the GARDEN counts.
 */
export function activeGardenProcessorIds(
  garden: GardenPhaseResult,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const run of garden.runs) {
    if (run.effectCount > 0) ids.add(run.processorId);
  }
  return [...ids].sort();
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
    ];
    const gardenProcessors = activeGardenProcessorIds(garden);
    if (gardenProcessors.length > 0) {
      gardenRows.push({
        label: "processors",
        value: gardenProcessors.join(", "),
      });
    }
    gardenRows.push(
      { label: "rejected patches", value: `${garden.rejectedPatchCount}` },
      { label: "diagnostics", value: `${garden.diagnostics.length}` },
    );
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
