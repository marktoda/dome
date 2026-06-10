// cli/commands/doctor: read-only operational health checks.
//
// `dome doctor` is the human/agent recovery dashboard for engine substrate
// failures that need attention. It does not mutate state. The repair half of
// the recovery loop remains the engine-asks path: health processors raise
// questions, the user resolves them with `dome resolve`, and answer handlers apply
// the mutation.

import { basename } from "node:path";

import { probeCommandModelProvider } from "../../engine/command-model-provider";
import {
  collectHealthReport,
  collectOperationalSchemaReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthReport,
  type ModelProviderProbeInput,
} from "../../engine/health";
import { writeModelProviderProbeCache } from "../../engine/model-provider-probe-cache";
import { openVaultRuntime } from "../../engine/vault-runtime";
import { emitRuntimeOpenFailure } from "../command-error";
import { formatJson } from "../format";
import { formatSeverity } from "../human-output";
import {
  bullets,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
  type Status,
} from "../presenter";
import { resolveBundleRoots } from "./sync-shared";
import { parseNonNegativeIntegerValue } from "../parse-options";

import { resolveVaultPath } from "../resolve-vault";
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

  const vaultPath = resolveVaultPath(options.vault);
  const bundleRoots = resolveBundleRoots({
    vaultPath,
    bundlesRoot: options.bundlesRoot,
  });

  const storageReport = collectOperationalSchemaReport({ vaultPath });
  if (storageReport.status === "unhealthy") {
    if (options.json === true) {
      console.log(formatJson(storageReport));
    } else {
      printDoctorText(storageReport, vaultPath);
    }
    return 0;
  }

  const runtimeResult = await openVaultRuntime({ vaultPath, ...bundleRoots });
  if (!runtimeResult.ok) {
    return emitRuntimeOpenFailure({
      command: "doctor",
      json: options.json === true,
      errorKind: runtimeResult.error.kind,
    });
  }
  const runtime = runtimeResult.value;

  try {
    // Probe the configured command model provider with a cheap
    // dome.model-provider.probe/v1 envelope (no network / paid API call on a
    // conforming provider). Doctor is the probe verb — `dome check` reuses
    // the same HealthReport machinery without spawning the provider.
    const providerConfig = runtime.config.modelProvider;
    let modelProviderProbe: ModelProviderProbeInput | undefined;
    if (providerConfig !== undefined) {
      modelProviderProbe = {
        command: providerConfig.command,
        result: await probeCommandModelProvider(providerConfig, {
          cwd: runtime.path,
        }),
      };
      // Persist the outcome (derived state, gitignored) so `dome status`
      // can report last-known provider reachability without spawning the
      // provider. Best-effort — the live result above is authoritative.
      writeModelProviderProbeCache(runtime.path, {
        command: modelProviderProbe.command,
        probedAt: new Date(),
        result: modelProviderProbe.result,
      });
    }

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
      extensionConfigFor: runtime.extensionConfigFor,
      modelProviderConfigured: runtime.modelProvider !== undefined,
      ...(modelProviderProbe !== undefined ? { modelProviderProbe } : {}),
      orphanRunThresholdMs: orphanThresholdMs,
    });
    if (options.json === true) {
      console.log(formatJson(report));
    } else {
      printDoctorText(report, vaultPath, modelProviderProbe);
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

function printDoctorText(
  report: HealthReport,
  vaultPath: string,
  modelProviderProbe?: ModelProviderProbeInput,
): void {
  const caps = resolveCaps();
  // Info-only findings keep status "ok" but still deserve a visible label.
  const headStatus: Status = report.status === "ok"
    ? report.summary.findingCount === 0
      ? { tone: "ok", label: "ok" }
      : { tone: "ok", label: `${report.summary.infoCount} info` }
    : { tone: "warn", label: `${report.summary.findingCount} finding${report.summary.findingCount === 1 ? "" : "s"}` };

  const lines: string[] = [
    headline({ cmd: "doctor", context: basename(vaultPath) }, headStatus, caps),
  ];

  if (report.findings.length === 0) {
    lines.push(...section("Findings", bullets([], caps), caps));
  } else {
    const findingBullets: string[] = [];
    for (const finding of report.findings) {
      findingBullets.push(
        `[${formatSeverity(finding.severity)}] ${finding.code}: ${finding.message}`,
      );
      findingBullets.push(`  recovery: ${finding.recovery}`);
    }
    lines.push(...section("Findings", findingBullets.map((l) => `  ${l}`), caps));

    lines.push(
      ...section(
        "At a glance",
        kv(
          [
            {
              label: "health",
              value: `${report.summary.errorCount} error · ${report.summary.warningCount} warning · ${report.summary.infoCount} info`,
            },
            {
              label: "findings",
              value:
                `outbox ${report.summary.failedOutbox} failed · ` +
                `${report.summary.stuckPendingOutbox} stuck · ` +
                `orphans ${report.summary.orphanRuns} · ` +
                `runs ${report.summary.failedRuns} failed · ` +
                `quarantine ${report.summary.quarantinedProcessors} · ` +
                `projection ${report.summary.projectionCacheDrift} · ` +
                `git ${report.summary.adoptedRefDivergence} · ` +
                `instructions ${report.summary.instructionDrift} · ` +
                `storage ${report.summary.operationalSchemaMismatch} · ` +
                `grants ${report.summary.capabilityGrantGaps} kind · ` +
                `${report.summary.capabilityGrantEntryGaps} entry · ` +
                `daily_path ${report.summary.dailyPathMismatch} · ` +
                `edition ${report.summary.dailyEditionNotCompiled} missed · ` +
                `calendar ${report.summary.dailyCalendarSourceMissing} missing · ` +
                `model ${report.summary.modelProviderMissing} missing · ` +
                `${report.summary.modelProviderUnreachable} unreachable · ` +
                `${report.summary.modelProviderKeyMissing} keyless`,
            },
          ],
          caps,
        ),
        caps,
      ),
    );
  }

  // probe-unsupported is documented as "alive; no finding" (see
  // docs/wiki/specs/cli.md §"dome doctor"), but invisibility hides a
  // genuinely crashed provider behind a healthy-looking report. Render a
  // muted info line — classification unchanged, just visible.
  if (
    modelProviderProbe !== undefined &&
    modelProviderProbe.result.status === "probe-unsupported"
  ) {
    lines.push(
      ...section(
        "Model provider",
        kv(
          [
            {
              label: "probe",
              value:
                "unsupported (provider treated as alive; no finding) — " +
                modelProviderProbe.result.detail,
              tone: "muted",
            },
          ],
          caps,
        ),
        caps,
      ),
    );
  }

  const footerStatus: Status = report.status === "ok"
    ? { tone: "ok", label: "all clear" }
    : { tone: "warn", label: "needs attention" };
  lines.push(...footer(footerStatus, caps));

  console.log(lines.join("\n"));
}

function parseNonNegativeInteger(
  raw: string | number | undefined,
  fallback: number,
): number | null {
  return parseNonNegativeIntegerValue(raw, fallback);
}
