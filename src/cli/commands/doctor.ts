// cli/commands/doctor: read-only operational health checks.
//
// `dome doctor` is the human/agent recovery dashboard for engine substrate
// failures that need attention. It does not mutate state. The repair half of
// the recovery loop remains the engine-asks path: health processors raise
// questions, the user resolves them with `dome resolve`, and answer handlers apply
// the mutation.

import { resolve } from "node:path";

import {
  collectHealthReport,
  collectOperationalSchemaReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthFinding,
  type HealthReport,
} from "../../engine/health";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { formatJson } from "../format";
import {
  formatHeadline,
  formatSeverity,
  formatSummaryRows,
  pushSection,
} from "../human-output";
import { resolveBundleRoots } from "./sync-shared";
import { parseNonNegativeIntegerValue } from "../parse-options";

const EX_USAGE = 64;

export type RunDoctorOptions = {
  readonly repair?: boolean | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly orphanThresholdMs?: string | number | undefined;
};

export async function runDoctor(
  options: RunDoctorOptions = {},
): Promise<number> {
  if (options.repair === true) {
    console.error(
      "dome doctor --repair is reserved in V1. Recovery mutations flow " +
        "through health questions and `dome resolve`; `dome doctor` is " +
        "probe-only.",
    );
    return EX_USAGE;
  }

  const orphanThresholdMs = parseNonNegativeInteger(
    options.orphanThresholdMs,
    DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  );
  if (orphanThresholdMs === null) {
    console.error(
      "dome doctor: --orphan-threshold-ms must be a non-negative integer.",
    );
    return EX_USAGE;
  }

  const vaultPath = resolve(options.vault ?? process.cwd());
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });

  const storageReport = collectOperationalSchemaReport({ vaultPath });
  if (storageReport.status === "unhealthy") {
    if (options.json === true) {
      console.log(formatJson(storageReport));
    } else {
      printDoctorText(storageReport);
    }
    return 0;
  }

  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    console.error(
      `dome doctor: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const report = await collectHealthReport({
      vaultPath: runtime.path,
      projection: runtime.projectionDb,
      ledger: runtime.ledgerDb,
      outbox: runtime.outboxDb,
      executionState: runtime.processorRuntime.executionState,
      extensions: runtime.extensions,
      processorVersions: runtime.processorVersions,
      capabilityPolicyHash: runtime.capabilityPolicyHash,
      registry: runtime.registry,
      resolveGrants: runtime.resolveGrants,
      modelProviderConfigured: runtime.modelProvider !== undefined,
      orphanRunThresholdMs: orphanThresholdMs,
    });
    if (options.json === true) {
      console.log(formatJson(report));
    } else {
      printDoctorText(report);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

function printDoctorText(report: HealthReport): void {
  const lines = [
    formatHeadline(
      "Dome doctor",
      report.status === "ok" ? "ok" : "needs attention",
    ),
  ];
  if (report.status === "ok") {
    pushSection(lines, "Summary", formatSummaryRows([
      ["health", "ok"],
      ["findings", "0"],
    ]));
    console.log(lines.join("\n"));
    return;
  }

  pushSection(lines, "Summary", formatSummaryRows([
    [
      "health",
      `${report.summary.errorCount} error | ${report.summary.warningCount} warning`,
    ],
    [
      "findings",
      `outbox ${report.summary.failedOutbox} failed | ` +
        `${report.summary.stuckPendingOutbox} stuck | ` +
        `orphans ${report.summary.orphanRuns} | ` +
        `runs ${report.summary.failedRuns} failed | ` +
        `quarantine ${report.summary.quarantinedProcessors} | ` +
        `projection ${report.summary.projectionCacheDrift} | ` +
        `git ${report.summary.adoptedRefDivergence} | ` +
        `instructions ${report.summary.instructionDrift} | ` +
        `storage ${report.summary.operationalSchemaMismatch} | ` +
        `grants ${report.summary.capabilityGrantGaps} | ` +
        `model ${report.summary.modelProviderMissing}`,
    ],
  ]));
  const findingLines: string[] = [];
  for (const finding of report.findings) {
    findingLines.push(formatFinding(finding));
    findingLines.push(`    recovery: ${finding.recovery}`);
  }
  pushSection(lines, "Findings", findingLines);
  console.log(lines.join("\n"));
}

function formatFinding(finding: HealthFinding): string {
  return `  - [${formatSeverity(finding.severity)}] ${finding.code} (${finding.id}): ${finding.message}`;
}

function parseNonNegativeInteger(
  raw: string | number | undefined,
  fallback: number,
): number | null {
  return parseNonNegativeIntegerValue(raw, fallback);
}
