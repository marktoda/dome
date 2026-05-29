// cli/commands/doctor: read-only operational health checks.
//
// `dome doctor` is the human/agent recovery dashboard for engine substrate
// failures that need attention. It does not mutate state. The repair half of
// the recovery loop remains the engine-asks path: health processors raise
// questions, the user answers with `dome answer`, and answer handlers apply
// the mutation.

import { resolve } from "node:path";

import {
  collectHealthReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthFinding,
  type HealthReport,
} from "../../engine/health";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { formatJson } from "../format";
import { resolveShippedBundlesRoot } from "./sync-shared";

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
      "dome doctor --repair: not implemented yet. Recovery mutations flow " +
        "through health questions and `dome answer`; this command is " +
        "currently probe-only.",
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
  const bundlesRoot = options.bundlesRoot ?? resolveShippedBundlesRoot();
  const runtimeResult = await openVaultRuntime({ vaultPath, bundlesRoot });
  if (!runtimeResult.ok) {
    console.error(
      `dome doctor: openVaultRuntime failed (${runtimeResult.error.kind}). Run \`dome init\` first to initialize the vault.`,
    );
    return 1;
  }
  const runtime = runtimeResult.value;

  try {
    const report = collectHealthReport({
      ledger: runtime.ledgerDb,
      outbox: runtime.outboxDb,
      executionState: runtime.processorRuntime.executionState,
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
  console.log("DOME doctor");
  if (report.status === "ok") {
    console.log("health    ok");
    console.log("findings  0");
    return;
  }

  console.log(
    `health    ${report.summary.errorCount} error | ` +
      `${report.summary.warningCount} warning`,
  );
  console.log(
    `findings  outbox ${report.summary.failedOutbox} failed | ` +
      `orphans ${report.summary.orphanRuns} | ` +
      `quarantine ${report.summary.quarantinedProcessors}`,
  );
  for (const finding of report.findings) {
    console.log(formatFinding(finding));
  }
}

function formatFinding(finding: HealthFinding): string {
  return [
    finding.severity.padEnd(7),
    finding.code.padEnd(22),
    finding.id,
    "-",
    finding.message,
  ].join(" ");
}

function parseNonNegativeInteger(
  raw: string | number | undefined,
  fallback: number,
): number | null {
  if (raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
