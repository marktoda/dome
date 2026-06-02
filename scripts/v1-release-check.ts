#!/usr/bin/env bun

import { resolve } from "node:path";

type ReleaseCheckOptions = {
  readonly json: boolean;
  readonly dryRun: boolean;
};

type GateId =
  | "implementation"
  | "collection-readiness"
  | "release-soak";

type Gate = {
  readonly id: GateId;
  readonly label: string;
  readonly cwd: string;
  readonly command: ReadonlyArray<string>;
};

type GateResult = {
  readonly id: GateId;
  readonly label: string;
  readonly cwd: string;
  readonly command: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
};

type GateReportResult = Omit<GateResult, "stdout" | "stderr"> & {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutChars: number;
  readonly stderrChars: number;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutOmittedChars: number;
  readonly stderrOmittedChars: number;
};

type ReleaseCheckReport =
  | {
      readonly status: "dry-run";
      readonly gates: ReadonlyArray<{
        readonly id: GateId;
        readonly label: string;
        readonly cwd: string;
        readonly command: ReadonlyArray<string>;
      }>;
    }
  | {
      readonly status: "ready" | "not-ready";
      readonly gates: ReadonlyArray<GateReportResult>;
    };

const JSON_OUTPUT_LIMIT_CHARS = 12000;
const repoRoot = resolve(import.meta.dir, "..");

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const gates = releaseCheckPlan();

  if (opts.dryRun) {
    const report: ReleaseCheckReport = {
      status: "dry-run",
      gates: gates.map(displayGate),
    };
    nodeWrite(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderDryRun(gates));
    return;
  }

  const results: GateResult[] = [];
  for (const gate of gates) {
    if (!opts.json) {
      nodeWrite(
        `\n== ${gate.label}\ncwd: ${gate.cwd}\n$ ${shellCommand(displayCommand(gate.command))}\n`,
      );
    }
    const result = await runGate(gate);
    results.push(result);
    if (!opts.json) {
      nodeWrite(result.stdout);
      nodeWrite(result.stderr);
      if (result.stdout !== "" && !result.stdout.endsWith("\n")) nodeWrite("\n");
      if (result.stderr !== "" && !result.stderr.endsWith("\n")) nodeWrite("\n");
      nodeWrite(
        `v1-release-check: ${result.label} ${
          result.exitCode === 0 ? "passed" : `failed with exit ${result.exitCode}`
        } (${formatDuration(result.durationMs)})\n`,
      );
    }
  }

  const ready = results.every((result) => result.exitCode === 0);
  const report: ReleaseCheckReport = {
    status: ready ? "ready" : "not-ready",
    gates: results.map(displayResult),
  };
  nodeWrite(opts.json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  if (!ready) process.exit(1);
}

function releaseCheckPlan(): ReadonlyArray<Gate> {
  return Object.freeze([
    {
      id: "implementation" as const,
      label: "Implementation gates",
      cwd: repoRoot,
      command: Object.freeze([process.execPath, "run", "v1:check"]),
    },
    {
      id: "collection-readiness" as const,
      label: "Current dogfood collection readiness",
      cwd: repoRoot,
      command: Object.freeze([
        process.execPath,
        "run",
        "v1:dogfood-preflight",
        "--",
        "--require-ready",
      ]),
    },
    {
      id: "release-soak" as const,
      label: "M10 release-soak evidence",
      cwd: repoRoot,
      command: Object.freeze([
        process.execPath,
        "run",
        "v1:dogfood-report",
        "--",
        "--require-ready",
      ]),
    },
  ]);
}

async function runGate(gate: Gate): Promise<GateResult> {
  const startedAt = Date.now();
  const proc = Bun.spawn({
    cmd: [...gate.command],
    cwd: gate.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    id: gate.id,
    label: gate.label,
    cwd: gate.cwd,
    command: displayCommand(gate.command),
    exitCode,
    durationMs: Date.now() - startedAt,
    stdout,
    stderr,
  };
}

function displayGate(gate: Gate): {
  readonly id: GateId;
  readonly label: string;
  readonly cwd: string;
  readonly command: ReadonlyArray<string>;
} {
  return {
    id: gate.id,
    label: gate.label,
    cwd: gate.cwd,
    command: displayCommand(gate.command),
  };
}

function displayResult(result: GateResult): GateReportResult {
  const stdout = summarizeGateOutput(result.stdout);
  const stderr = summarizeGateOutput(result.stderr);
  return {
    ...result,
    command: displayCommand(result.command),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutChars: stdout.chars,
    stderrChars: stderr.chars,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutOmittedChars: stdout.omittedChars,
    stderrOmittedChars: stderr.omittedChars,
  };
}

export function summarizeGateOutput(
  text: string,
  limitChars = JSON_OUTPUT_LIMIT_CHARS,
): {
  readonly text: string;
  readonly chars: number;
  readonly truncated: boolean;
  readonly omittedChars: number;
} {
  if (!Number.isInteger(limitChars) || limitChars < 1) {
    throw new Error("limitChars must be a positive integer");
  }
  if (text.length <= limitChars) {
    return {
      text,
      chars: text.length,
      truncated: false,
      omittedChars: 0,
    };
  }

  const marker = `\n[... omitted ${text.length - limitChars} character(s) ...]\n`;
  return {
    text: `${marker}${text.slice(-limitChars)}`,
    chars: text.length,
    truncated: true,
    omittedChars: text.length - limitChars,
  };
}

function displayCommand(command: ReadonlyArray<string>): ReadonlyArray<string> {
  if (command[0] !== process.execPath) return Object.freeze([...command]);
  return Object.freeze(["bun", ...command.slice(1)]);
}

function renderDryRun(gates: ReadonlyArray<Gate>): string {
  const lines = [
    "V1 release check plan:",
    `Working directory: ${repoRoot}`,
    ...gates.map((gate) =>
      `- ${gate.label}: ${shellCommand(displayCommand(gate.command))}`
    ),
    "",
  ];
  return lines.join("\n");
}

function renderReport(report: ReleaseCheckReport): string {
  if (report.status === "dry-run") return renderDryRun(report.gates);
  const lines = [
    "",
    "V1 release check summary:",
    `Working directory: ${repoRoot}`,
    ...report.gates.map((gate) =>
      `- ${gate.label}: ${gate.exitCode === 0 ? "pass" : `fail (${gate.exitCode})`}`
    ),
    `Result: ${report.status}`,
    "",
  ];
  return lines.join("\n");
}

function parseArgs(args: ReadonlyArray<string>): ReleaseCheckOptions {
  let json = false;
  let dryRun = false;
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    failUsage(`unknown argument: ${arg}`);
  }
  return { json, dryRun };
}

function printHelp(): void {
  nodeWrite([
    "Usage: bun scripts/v1-release-check.ts [options]",
    "",
    "Runs the final V1 release gates and reports every gate before exiting.",
    "All gates run from the repository root.",
    "",
    "Gates:",
    "  1. bun run v1:check",
    "  2. bun run v1:dogfood-preflight -- --require-ready",
    "  3. bun run v1:dogfood-report -- --require-ready",
    "",
    "Options:",
    "  --json       Emit machine-readable JSON.",
    "  --dry-run    Print the gate plan without running commands.",
    "  -h, --help   Show this help.",
    "",
  ].join("\n"));
}

function failUsage(message: string): never {
  console.error(`v1-release-check: ${message}`);
  process.exit(64);
}

function shellCommand(command: ReadonlyArray<string>): string {
  return command.map(formatShellArg).join(" ");
}

function formatShellArg(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function nodeWrite(text: string): void {
  process.stdout.write(text);
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`v1-release-check: ${message}`);
    process.exit(1);
  });
}
