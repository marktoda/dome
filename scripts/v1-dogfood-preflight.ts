#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

type PreflightOptions = {
  readonly vault: string;
  readonly ledger: string;
  readonly json: boolean;
  readonly requireReady: boolean;
};

type CommandRun = {
  readonly command: ReadonlyArray<string>;
};

type CheckSummary = {
  readonly ready: boolean;
  readonly findings: ReadonlyArray<string>;
};

type PreflightReport = {
  readonly vault: string;
  readonly ledger: string;
  readonly status: "ready" | "not-ready";
  readonly sessionEvidence: {
    readonly serveCommand: ReadonlyArray<string>;
    readonly snapshotCommand: ReadonlyArray<string>;
    readonly appendCommand: string;
  };
  readonly operational: CheckSummary;
  readonly serve: CheckSummary & {
    readonly status: string;
    readonly pid: number | null;
    readonly branch: string | null;
    readonly updatedAt: string | null;
  };
  readonly capture: CheckSummary & {
    readonly intakeStatus: string;
    readonly intakeLoaded: boolean;
    readonly modelStatus: string;
  };
  readonly release: {
    readonly status: string;
    readonly completeWorkdays: number;
    readonly serveHostEvidenceDays: number;
    readonly captureEvidenceDays: number;
    readonly spanCalendarDays: number;
    readonly releaseBlockers: number;
    readonly readiness: ReadonlyArray<ReleaseCriterion>;
  };
  readonly nextActions: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
};

type ReleaseCriterion = {
  readonly id: string;
  readonly label: string;
  readonly current: number;
  readonly required: number;
  readonly remaining: number;
  readonly ready: boolean;
};

const repoRoot = resolve(import.meta.dir, "..");
const defaultLedger = resolve(
  repoRoot,
  "docs/cohesive/reviews/2026-06-02-v1-work-vault-dogfood-ledger.md",
);

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const commands: CommandRun[] = [];
  const status = await runJson<JsonRecord>(commands, [
    resolve(repoRoot, "bin", "dome"),
    "status",
    "--vault",
    opts.vault,
    "--json",
  ]);
  const bundles = await runJson<JsonRecord[]>(commands, [
    resolve(repoRoot, "bin", "dome"),
    "inspect",
    "bundles",
    "--vault",
    opts.vault,
    "--model",
    "--json",
  ]);
  const release = await runJson<JsonRecord>(commands, [
    process.execPath,
    resolve(repoRoot, "scripts", "v1-dogfood-report.ts"),
    "--ledger",
    opts.ledger,
    "--json",
  ]);

  const report = buildReport({
    opts,
    commands,
    status,
    bundles,
    release,
  });
  nodeWrite(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  if (opts.requireReady && report.status !== "ready") {
    process.exit(1);
  }
}

function buildReport(input: {
  readonly opts: PreflightOptions;
  readonly commands: ReadonlyArray<CommandRun>;
  readonly status: JsonRecord;
  readonly bundles: ReadonlyArray<JsonRecord>;
  readonly release: JsonRecord;
}): PreflightReport {
  const operational = operationalCheck(input.status);
  const serve = serveCheck(input.status);
  const capture = captureCheck(input.bundles);
  const releaseBlockers = recordArray(input.release.releaseBlockers);
  const release = {
    status: stringValue(input.release.status, "unknown"),
    completeWorkdays: numberValue(input.release.completeWorkdays),
    serveHostEvidenceDays: numberValue(input.release.serveHostEvidenceDays),
    captureEvidenceDays: numberValue(input.release.captureEvidenceDays),
    spanCalendarDays: numberValue(input.release.spanCalendarDays),
    releaseBlockers: releaseBlockers.length,
    readiness: releaseCriteria(input.release),
  };
  const sessionEvidence = sessionEvidenceCommands(input.opts);
  const nextActions = buildNextActions({
    operational,
    operationalNextActions: statusNextActionStrings(input.status),
    serve,
    serveCommand: shellCommand(sessionEvidence.serveCommand),
    capture,
    release,
  });
  const ready = operational.ready && serve.ready && capture.ready;
  return {
    vault: input.opts.vault,
    ledger: input.opts.ledger,
    status: ready ? "ready" : "not-ready",
    sessionEvidence,
    operational,
    serve,
    capture,
    release,
    nextActions,
    commands: input.commands.map((command) => command.command),
  };
}

function sessionEvidenceCommands(opts: PreflightOptions): {
  readonly serveCommand: ReadonlyArray<string>;
  readonly snapshotCommand: ReadonlyArray<string>;
  readonly appendCommand: string;
} {
  const serveCommand = Object.freeze([
    "bin/dome",
    "serve",
    "--vault",
    opts.vault,
    "--quiet",
    "--poll-interval-ms",
    "1000",
  ]);
  const snapshotCommand = Object.freeze([
    "bun",
    "run",
    "v1:dogfood-snapshot",
    "--",
    "--vault",
    opts.vault,
    "--date",
    localDateString(),
  ]);
  const renderedSnapshotCommand = snapshotCommand.map(formatShellArg).join(" ");
  return Object.freeze({
    serveCommand,
    snapshotCommand,
    appendCommand:
      `${renderedSnapshotCommand} >> ${formatShellArg(opts.ledger)}`,
  });
}

function serveCheck(status: JsonRecord): CheckSummary & {
  readonly status: string;
  readonly pid: number | null;
  readonly branch: string | null;
  readonly updatedAt: string | null;
} {
  const serveStatus = stringValue(status.serve_status, "unknown");
  const currentBranch = nullableString(status.branch);
  const serveBranch = nullableString(status.serve_branch);
  const findings: string[] = [];
  if (serveStatus === "off") {
    findings.push(
      "dome serve is off; start it during real work sessions for M10 host evidence",
    );
  } else if (serveStatus === "stale") {
    findings.push("dome serve heartbeat is stale; restart the foreground host");
  } else if (serveStatus !== "running") {
    findings.push(`dome serve status is ${serveStatus}`);
  } else if (
    currentBranch !== null &&
    serveBranch !== null &&
    serveBranch !== currentBranch
  ) {
    findings.push(
      `dome serve is running on branch ${serveBranch}, but the vault is on ${currentBranch}`,
    );
  }

  return {
    ready: findings.length === 0,
    findings,
    status: serveStatus,
    pid: nullableNumber(status.serve_pid),
    branch: serveBranch,
    updatedAt: nullableString(status.serve_updated_at),
  };
}

function operationalCheck(status: JsonRecord): CheckSummary {
  const findings: string[] = [];
  if (status.sync_needed === true) findings.push("vault has pending sync work");
  if (
    status.attention_required === true &&
    hasNonServeAttention(status.attention)
  ) {
    findings.push("status requires operator attention");
  }
  const dirtyModified = numberValue(status.dirty_modified);
  const dirtyUntracked = numberValue(status.dirty_untracked);
  if (dirtyModified > 0 || dirtyUntracked > 0) {
    findings.push(
      `working tree has ${dirtyModified} modified and ` +
        `${dirtyUntracked} untracked file(s)`,
    );
  }
  if (numberValue(status.pending_runs) > 0) {
    findings.push("there are pending processor runs");
  }
  if (numberValue(status.failed_runs) > 0) {
    findings.push("there are failed processor runs");
  }
  if (numberValue(status.outbox_failed) > 0) {
    findings.push("there are failed outbox rows");
  }
  if (numberValue(status.quarantined) > 0) {
    findings.push("there are quarantined processors");
  }
  return {
    ready: findings.length === 0,
    findings,
  };
}

function hasNonServeAttention(value: unknown): boolean {
  if (!Array.isArray(value)) return true;
  if (value.length === 0) return true;
  return value.some(
    (item) => typeof item !== "string" || item !== "serve_stale",
  );
}

function captureCheck(
  bundles: ReadonlyArray<JsonRecord>,
): CheckSummary & {
  readonly intakeStatus: string;
  readonly intakeLoaded: boolean;
  readonly modelStatus: string;
} {
  const intake = bundles.find((row) => row.bundle === "dome.intake");
  const findings: string[] = [];
  if (intake === undefined) {
    findings.push("dome.intake bundle is not visible");
    return {
      ready: false,
      findings,
      intakeStatus: "missing",
      intakeLoaded: false,
      modelStatus: "unknown",
    };
  }

  const intakeStatus = stringValue(intake.status, "unknown");
  const intakeLoaded = intake.loaded === true;
  const modelStatus = stringValue(intake.model, "unknown");
  if (intakeStatus !== "enabled") {
    findings.push(`dome.intake is ${intakeStatus}`);
  }
  if (!intakeLoaded) {
    findings.push("dome.intake processors are not loaded");
  }
  if (modelStatus !== "ready") {
    findings.push(`dome.intake model status is ${modelStatus}`);
  }

  return {
    ready: findings.length === 0,
    findings,
    intakeStatus,
    intakeLoaded,
    modelStatus,
  };
}

function buildNextActions(input: {
  readonly operational: CheckSummary;
  readonly operationalNextActions: ReadonlyArray<string>;
  readonly serve: CheckSummary;
  readonly serveCommand: string;
  readonly capture: CheckSummary;
  readonly release: PreflightReport["release"];
}): string[] {
  const actions: string[] = [];
  if (!input.operational.ready) {
    if (input.operationalNextActions.length === 0) {
      actions.push("clear operational findings before recording a dogfood session");
    } else {
      actions.push(...input.operationalNextActions);
    }
  }
  if (!input.capture.ready) {
    actions.push(
      "enable dome.intake with a configured model provider before capture dogfood",
    );
  }
  if (!input.serve.ready) {
    actions.push(
      `start dome serve while dogfooding to collect host evidence ` +
        `(${input.serveCommand})`,
    );
  }
  if (input.release.status !== "ready") {
    const releaseActions = releaseNextActions(input.release.readiness);
    actions.push(
      ...(releaseActions.length === 0
        ? ["continue recording measured dogfood snapshots and filled M10 notes"]
        : releaseActions),
    );
  }
  if (actions.length === 0) {
    actions.push("run a dogfood session and append the snapshot to the ledger");
  }
  return actions;
}

function releaseNextActions(
  readiness: ReadonlyArray<ReleaseCriterion>,
): string[] {
  return readiness
    .filter((criterion) => !criterion.ready)
    .map((criterion) => {
      if (criterion.id === "release_blockers") {
        return `resolve ${criterion.remaining} M10 release blocker(s)`;
      }
      if (criterion.id === "complete_workdays") {
        return (
          `collect ${criterion.remaining} more complete M10 workday(s) ` +
          `(${criterion.current}/${criterion.required})`
        );
      }
      if (criterion.id === "serve_host_evidence_days") {
        return (
          `collect serve-host evidence on ${criterion.remaining} more day(s) ` +
          `(${criterion.current}/${criterion.required})`
        );
      }
      if (criterion.id === "capture_evidence_days") {
        return (
          `collect complete capture evidence on ${criterion.remaining} more ` +
          `workday(s) (${criterion.current}/${criterion.required})`
        );
      }
      if (criterion.id === "span_calendar_days") {
        return (
          `continue dogfood until complete days span ${criterion.remaining} ` +
          `more calendar day(s) (${criterion.current}/${criterion.required})`
        );
      }
      return (
        `collect ${criterion.remaining} more ${criterion.label.toLowerCase()} ` +
        `for M10 (${criterion.current}/${criterion.required})`
      );
    });
}

function statusNextActionStrings(status: JsonRecord): string[] {
  return recordArray(status.next_actions)
    .map((action) => {
      const description = stringValue(action.description, "");
      const command = stringValue(action.command, "");
      if (description === "" && command === "") return "";
      if (description === "") return command;
      if (command === "") return description;
      return `${description} (${command})`;
    })
    .filter((action) => action !== "");
}

function renderReport(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push("# V1 M10 Dogfood Preflight");
  lines.push("");
  lines.push(`Vault: \`${report.vault}\``);
  lines.push(`Ledger: \`${report.ledger}\``);
  lines.push(`Collection status: ${report.status}`);
  lines.push("");
  lines.push("Operational readiness:");
  lines.push(`- Ready: ${yesNo(report.operational.ready)}`);
  renderFindings(lines, report.operational.findings);
  lines.push("");
  lines.push("Serve-host evidence:");
  lines.push(`- Ready: ${yesNo(report.serve.ready)}`);
  lines.push(`- Status: ${report.serve.status}`);
  lines.push(`- Branch: ${report.serve.branch ?? "(none)"}`);
  lines.push(`- PID: ${report.serve.pid ?? "(none)"}`);
  lines.push(`- Updated at: ${report.serve.updatedAt ?? "(none)"}`);
  renderFindings(lines, report.serve.findings);
  lines.push("");
  lines.push("Capture readiness:");
  lines.push(`- Ready: ${yesNo(report.capture.ready)}`);
  lines.push(`- dome.intake status: ${report.capture.intakeStatus}`);
  lines.push(`- dome.intake loaded: ${yesNo(report.capture.intakeLoaded)}`);
  lines.push(`- model status: ${report.capture.modelStatus}`);
  renderFindings(lines, report.capture.findings);
  lines.push("");
  lines.push("Release-soak report:");
  lines.push(`- Status: ${report.release.status}`);
  lines.push(`- Complete workdays: ${report.release.completeWorkdays}`);
  lines.push(
    `- Serve-host evidence days: ${report.release.serveHostEvidenceDays}`,
  );
  lines.push(
    `- Complete capture-evidence days: ${report.release.captureEvidenceDays}`,
  );
  lines.push(`- Complete-workday span: ${report.release.spanCalendarDays}`);
  lines.push(`- Release blockers: ${report.release.releaseBlockers}`);
  if (report.release.readiness.length > 0) {
    lines.push("- Remaining criteria:");
    const incomplete = report.release.readiness.filter((criterion) =>
      !criterion.ready
    );
    if (incomplete.length === 0) {
      lines.push("  - All criteria satisfied.");
    } else {
      for (const criterion of incomplete) {
        lines.push(`  - ${formatReleaseCriterion(criterion)}`);
      }
    }
  }
  lines.push("");
  lines.push("Session evidence:");
  lines.push(
    `- Serve command: \`${shellCommand(report.sessionEvidence.serveCommand)}\``,
  );
  lines.push(`- Snapshot command: \`${report.sessionEvidence.appendCommand}\``);
  lines.push(
    "- Fill the qualitative prompts after the work session before counting the day.",
  );
  lines.push("");
  lines.push("Next actions:");
  for (const action of report.nextActions) {
    lines.push(`- ${action}`);
  }
  lines.push("");
  lines.push("Commands run:");
  for (const command of report.commands) {
    lines.push(`- \`${command.map(formatCommandArg).join(" ")}\``);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function formatReleaseCriterion(criterion: ReleaseCriterion): string {
  if (criterion.id === "release_blockers") {
    return `${criterion.label}: resolve ${criterion.remaining} blocker(s)`;
  }
  if (criterion.id === "span_calendar_days") {
    return (
      `${criterion.label}: need ${criterion.remaining} more calendar day(s) ` +
      `(${criterion.current}/${criterion.required})`
    );
  }
  return (
    `${criterion.label}: need ${criterion.remaining} more ` +
    `(${criterion.current}/${criterion.required})`
  );
}

function renderFindings(lines: string[], findings: ReadonlyArray<string>): void {
  if (findings.length === 0) {
    lines.push("- Findings: none");
    return;
  }
  lines.push("- Findings:");
  for (const finding of findings) {
    lines.push(`  - ${finding}`);
  }
}

async function runJson<T>(
  commands: CommandRun[],
  command: ReadonlyArray<string>,
): Promise<T> {
  commands.push({ command });
  const proc = Bun.spawn({
    cmd: [...command],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${exitCode}${formatStderr(stderr)}`,
    );
  }
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${command.join(" ")} returned non-JSON stdout: ${message}`);
  }
}

function parseArgs(args: ReadonlyArray<string>): PreflightOptions {
  let vault = resolve(homedir(), "vaults", "work");
  let ledger = defaultLedger;
  let json = false;
  let requireReady = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--vault") {
      vault = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--ledger") {
      ledger = resolve(readValue(args, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--require-ready") {
      requireReady = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze({ vault, ledger, json, requireReady });
}

function readValue(
  args: ReadonlyArray<string>,
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function recordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is JsonRecord =>
      item !== null && typeof item === "object" && !Array.isArray(item),
  );
}

function releaseCriteria(release: JsonRecord): ReadonlyArray<ReleaseCriterion> {
  return Object.freeze(
    recordArray(release.readiness).map((row) =>
      Object.freeze({
        id: stringValue(row.id, "unknown"),
        label: stringValue(row.label, "Release criterion"),
        current: numberValue(row.current),
        required: numberValue(row.required),
        remaining: numberValue(row.remaining),
        ready: row.ready === true,
      })
    ),
  );
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : `: ${trimmed}`;
}

function formatCommandArg(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)
    ? value
    : JSON.stringify(value);
}

function shellCommand(command: ReadonlyArray<string>): string {
  return command.map(formatShellArg).join(" ");
}

function formatShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function localDateString(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function printHelp(): void {
  nodeWrite([
    "Usage: bun scripts/v1-dogfood-preflight.ts [options]",
    "",
    "Checks whether a vault is ready to collect the next M10 dogfood session.",
    "",
    "Options:",
    "  --vault <path>       Vault path (default: ~/vaults/work).",
    "  --ledger <path>      Dogfood ledger path.",
    "  --json               Emit machine-readable JSON.",
    "  --require-ready      Exit nonzero unless collection readiness passes.",
    "  -h, --help           Show this help.",
    "",
  ].join("\n"));
}

function nodeWrite(text: string): void {
  process.stdout.write(text);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`v1-dogfood-preflight: ${message}`);
  process.exit(1);
});
