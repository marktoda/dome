// cli/commands/doctor: read-only operational health checks.
//
// `dome doctor` is the human/agent recovery dashboard for engine substrate
// failures that need attention. It does not mutate state. The repair half of
// the recovery loop remains the engine-asks path: health processors raise
// questions, the user resolves them with `dome resolve`, and answer handlers apply
// the mutation.

import { runtimeHealthReportInputs } from "../../surface/health-inputs";
import { basename } from "node:path";

import { probeCommandModelProvider } from "../../engine/host/command-model-provider";
import {
  collectHealthReport,
  collectOperationalSchemaReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  type HealthReport,
  type ModelProviderProbeInput,
} from "../../engine/host/health";
import { writeModelProviderProbeCache } from "../../engine/host/model-provider-probe-cache";
import { openVaultRuntime } from "../../engine/host/vault-runtime";
import { emitRuntimeOpenFailure } from "../command-error";
import { formatJson } from "../../surface/format";
import {
  bullets,
  dimZeros,
  footer,
  headline,
  kv,
  resolveCaps,
  section,
  type Status,
} from "../presenter";
import { findingLines } from "./health-finding-view";
import { resolveBundleRoots } from "./sync-shared";
import { parseNonNegativeIntegerValue } from "../parse-options";

import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

export type RunDoctorOptions = {
  readonly repair?: boolean | undefined;
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
  readonly verbose?: boolean | undefined;
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
      const verbose = options.verbose === true;
      printDoctorText(storageReport, vaultPath, undefined, verbose);
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

    // Probe the vault's EFFECTIVE commit.gpgsign (local + inherited global
    // config — the global inheritance is the day-one hazard). Doctor is the
    // probe verb; `dome check` reuses the HealthReport machinery without
    // spawning git.
    const commitSigningEnabled = await vaultCommitSigningEnabled(runtime.path);

    const report = await collectHealthReport({
      ...runtimeHealthReportInputs(runtime),
      ...(modelProviderProbe !== undefined ? { modelProviderProbe } : {}),
      ...(commitSigningEnabled !== undefined ? { commitSigningEnabled } : {}),
      orphanRunThresholdMs: orphanThresholdMs,
    });
    if (options.json === true) {
      console.log(formatJson(report));
    } else {
      const verbose = options.verbose === true;
      printDoctorText(report, vaultPath, modelProviderProbe, verbose);
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
  verbose: boolean = false,
): void {
  void verbose; // reserved for future task — not yet used to change output
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
    lines.push(...section("Findings", findingLines(report.findings, caps), caps));

    const breakdownTerms: ReadonlyArray<string> = [
      `outbox ${report.summary.failedOutbox} failed`,
      `${report.summary.stuckPendingOutbox} stuck`,
      `orphans ${report.summary.orphanRuns}`,
      `runs ${report.summary.failedRuns} failed`,
      `quarantine ${report.summary.quarantinedProcessors}`,
      `projection ${report.summary.projectionCacheDrift}`,
      `git ${report.summary.adoptedRefDivergence}`,
      `instructions ${report.summary.instructionDrift}`,
      `storage ${report.summary.operationalSchemaMismatch}`,
      `grants ${report.summary.capabilityGrantGaps} kind`,
      `${report.summary.capabilityGrantEntryGaps} entry`,
      `${report.summary.capabilityGrantStarvation} starved`,
      `daily_path ${report.summary.dailyPathMismatch}`,
      `edition ${report.summary.dailyEditionNotCompiled} missed`,
      `calendar ${report.summary.dailyCalendarSourceMissing} missing`,
      `model ${report.summary.modelProviderMissing} missing`,
      `${report.summary.modelProviderUnreachable} unreachable`,
      `${report.summary.modelProviderKeyMissing} keyless`,
    ];

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
              value: dimZeros(breakdownTerms, caps),
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

/**
 * The vault's effective `git config commit.gpgsign`, read by spawning
 * native git so local/global/system scopes resolve exactly as a shelled
 * `git commit` would see them. `--type=bool` has git itself canonicalize
 * every truthy spelling (`yes`/`on`/`1`/`true`) to the literal `true`.
 * Returns false when the key is unset (git exits 1) or carries a value git
 * cannot canonicalize, and undefined when git itself cannot be spawned —
 * undefined suppresses the probe rather than guessing.
 */
async function vaultCommitSigningEnabled(
  vaultPath: string,
): Promise<boolean | undefined> {
  try {
    const proc = Bun.spawn(
      [
        "git",
        "-C",
        vaultPath,
        "config",
        "--get",
        "--type=bool",
        "commit.gpgsign",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return false; // unset key → exit 1
    return stdout.trim() === "true";
  } catch {
    return undefined;
  }
}
