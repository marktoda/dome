// cli/commands/doctor: read-only operational health checks.
//
// `dome doctor` is the human/agent recovery dashboard for engine substrate
// failures that need attention. It does not mutate state. The repair half of
// the recovery loop remains the engine-asks path: health processors raise
// questions, the user resolves them with `dome resolve`, and answer handlers apply
// the mutation.

import { basename } from "node:path";

import { probeCommandModelProvider } from "../../engine/host/command-model-provider";
import {
  collectHealthReport,
  collectOperationalSchemaReport,
  DEFAULT_ORPHAN_RUN_THRESHOLD_MS,
  healthInputsFromRuntime,
  type HealthReport,
  type ModelProviderProbeInput,
} from "../../engine/host/health";
import { writeModelProviderProbeCache } from "../../engine/host/model-provider-probe-cache";
import { openVaultRuntime } from "../../engine/host/vault-runtime";
import { emitRuntimeOpenFailure } from "../command-error";
import { formatJson } from "../../surface/format";
import {
  dimZeros,
  headline,
  kv,
  resolveCaps,
  rollup,
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
      ...healthInputsFromRuntime(runtime),
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
  const caps = resolveCaps();
  const s = report.summary;

  // Verdict header: problems = error+warning, notes = info.
  const problems = s.errorCount + s.warningCount;
  const notes = s.infoCount;
  const headStatus: Status =
    problems === 0 && notes === 0
      ? { tone: "ok", label: "healthy" }
      : (() => {
          const parts: string[] = [];
          if (problems > 0) parts.push(`${problems} ${problems === 1 ? "problem" : "problems"}`);
          if (notes > 0) parts.push(`${notes} ${notes === 1 ? "note" : "notes"}`);
          return { tone: "warn", label: parts.join(" · ") };
        })();

  const lines: string[] = [
    headline({ cmd: "doctor", context: basename(vaultPath) }, headStatus, caps),
  ];

  // Per-category zero-check for the rollup. A category is "clean" when all
  // its counts are zero; unhealthy categories are represented by findings.
  const cleanCategories: string[] = [];
  if (s.failedOutbox + s.stuckPendingOutbox + s.recurringOutboxFailures === 0) cleanCategories.push("outbox");
  if (s.orphanRuns + s.failedRuns + s.recurringTimeouts === 0) cleanCategories.push("runs");
  if (s.quarantinedProcessors === 0) cleanCategories.push("quarantine");
  if (s.projectionCacheDrift === 0) cleanCategories.push("projection");
  if (s.adoptedRefDivergence + s.gitCommitSigning === 0) cleanCategories.push("git");
  if (s.instructionDrift === 0) cleanCategories.push("instructions");
  if (s.operationalSchemaMismatch === 0) cleanCategories.push("storage");
  if (s.capabilityGrantGaps + s.capabilityGrantEntryGaps + s.capabilityGrantStarvation === 0) cleanCategories.push("grants");
  if (s.dailyPathMismatch + s.dailyEditionNotCompiled + s.dailyCalendarSourceMissing === 0) cleanCategories.push("daily");
  if (s.duplicateTaskAnchors === 0) cleanCategories.push("tasks");
  if (s.sourcesTimeoutDefault + s.sourcesFetchScriptMissing === 0) cleanCategories.push("sources");
  if (s.modelProviderMissing + s.modelProviderUnreachable + s.modelProviderKeyMissing === 0) cleanCategories.push("model");
  if (s.unreadableQuestions === 0) cleanCategories.push("decisions");

  if (!verbose) {
    // Default: headerless — findings directly, then a single rollup line.
    // No ALLCAPS section wrappers, no footer, no rule.
    const fl = findingLines(report.findings, caps, false);
    if (fl.length > 0) {
      lines.push("");
      lines.push(...fl);
    }
    if (report.findings.length < 1 || cleanCategories.length > 0) {
      lines.push("");
      lines.push(rollup(cleanCategories, caps));
    }
  } else {
    // Verbose: FINDINGS section + full AT A GLANCE breakdown.
    if (report.findings.length > 0) {
      lines.push(...section("Findings", findingLines(report.findings, caps, true), caps));
    }

    const breakdownTerms: ReadonlyArray<string> = [
      `outbox ${s.failedOutbox} failed`,
      `${s.stuckPendingOutbox} stuck`,
      `orphans ${s.orphanRuns}`,
      `runs ${s.failedRuns} failed`,
      `quarantine ${s.quarantinedProcessors}`,
      `projection ${s.projectionCacheDrift}`,
      `git ${s.adoptedRefDivergence}`,
      `instructions ${s.instructionDrift}`,
      `storage ${s.operationalSchemaMismatch}`,
      `grants ${s.capabilityGrantGaps} kind`,
      `${s.capabilityGrantEntryGaps} entry`,
      `${s.capabilityGrantStarvation} starved`,
      `daily_path ${s.dailyPathMismatch}`,
      `edition ${s.dailyEditionNotCompiled} missed`,
      `calendar ${s.dailyCalendarSourceMissing} missing`,
      `model ${s.modelProviderMissing} missing`,
      `${s.modelProviderUnreachable} unreachable`,
      `${s.modelProviderKeyMissing} keyless`,
      `tasks ${s.duplicateTaskAnchors} duplicate anchors`,
    ];

    lines.push(
      ...section(
        "At a glance",
        kv(
          [
            {
              label: "health",
              value: `${s.errorCount} error · ${s.warningCount} warning · ${s.infoCount} info`,
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

  // No footer or full-width rule in either default or verbose mode.

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
