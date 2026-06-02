#!/usr/bin/env bun

import { homedir } from "node:os";
import { resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

type PreflightOptions = {
  readonly vault: string;
  readonly ledger: string;
  readonly json: boolean;
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
  readonly status: "ready" | "not-ready";
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
  };
  readonly nextActions: ReadonlyArray<string>;
  readonly commands: ReadonlyArray<ReadonlyArray<string>>;
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
  };
  const nextActions = buildNextActions({ operational, serve, capture, release });
  const ready = operational.ready && capture.ready;
  return {
    vault: input.opts.vault,
    status: ready ? "ready" : "not-ready",
    operational,
    serve,
    capture,
    release,
    nextActions,
    commands: input.commands.map((command) => command.command),
  };
}

function serveCheck(status: JsonRecord): CheckSummary & {
  readonly status: string;
  readonly pid: number | null;
  readonly branch: string | null;
  readonly updatedAt: string | null;
} {
  const serveStatus = stringValue(status.serve_status, "unknown");
  const findings: string[] = [];
  if (serveStatus === "off") {
    findings.push(
      "dome serve is off; start it during real work sessions for M10 host evidence",
    );
  } else if (serveStatus === "stale") {
    findings.push("dome serve heartbeat is stale; restart the foreground host");
  } else if (serveStatus !== "running") {
    findings.push(`dome serve status is ${serveStatus}`);
  }

  return {
    ready: findings.length === 0,
    findings,
    status: serveStatus,
    pid: nullableNumber(status.serve_pid),
    branch: nullableString(status.serve_branch),
    updatedAt: nullableString(status.serve_updated_at),
  };
}

function operationalCheck(status: JsonRecord): CheckSummary {
  const findings: string[] = [];
  if (status.sync_needed === true) findings.push("vault has pending sync work");
  if (status.attention_required === true) {
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
  readonly serve: CheckSummary;
  readonly capture: CheckSummary;
  readonly release: PreflightReport["release"];
}): string[] {
  const actions: string[] = [];
  if (!input.operational.ready) {
    actions.push("clear operational findings before recording a dogfood session");
  }
  if (!input.capture.ready) {
    actions.push(
      "enable dome.intake with a configured model provider before capture dogfood",
    );
  }
  if (!input.serve.ready) {
    actions.push("start dome serve while dogfooding to collect host evidence");
  }
  if (input.release.status !== "ready") {
    actions.push(
      "continue recording measured dogfood snapshots and filled M10 notes",
    );
  }
  if (actions.length === 0) {
    actions.push("run a dogfood session and append the snapshot to the ledger");
  }
  return actions;
}

function renderReport(report: PreflightReport): string {
  const lines: string[] = [];
  lines.push("# V1 M10 Dogfood Preflight");
  lines.push("");
  lines.push(`Vault: \`${report.vault}\``);
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
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return Object.freeze({ vault, ledger, json });
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
