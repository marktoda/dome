#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

type StatusPayload = {
  readonly vault: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly adopted: string | null;
  readonly sync_needed: boolean;
  readonly pending_commits: number | null;
  readonly adopted_diverged: boolean;
  readonly dirty_modified: number;
  readonly dirty_untracked: number;
  readonly diagnostics: number;
  readonly attention_diagnostics: number;
  readonly questions: number;
  readonly pending_runs: number;
  readonly failed_runs: number;
  readonly outbox_failed: number;
  readonly quarantined: number;
};

type DoctorPayload = {
  readonly status: "ok" | "warning" | "error";
  readonly summary: {
    readonly findingCount: number;
    readonly errorCount: number;
    readonly warningCount: number;
  };
};

type SmokeOptions = {
  readonly docsVault: string;
  readonly workVault: string | null;
  readonly syncDocs: boolean;
};

const repoRoot = resolve(import.meta.dir, "..");

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const docs = await smokeVault({
    label: "docs",
    vaultPath: opts.docsVault,
    syncIfNeeded: opts.syncDocs,
    requireCleanAdopted: opts.syncDocs,
  });

  let work: VaultSmokeResult | null = null;
  if (opts.workVault !== null) {
    if (existsSync(opts.workVault)) {
      work = await smokeVault({
        label: "work",
        vaultPath: opts.workVault,
        syncIfNeeded: false,
        requireCleanAdopted: false,
      });
    } else {
      console.log(`v1-smoke: work vault not found, skipping ${opts.workVault}`);
    }
  }

  printSummary([docs, ...(work === null ? [] : [work])]);
}

type VaultSmokeResult = {
  readonly label: string;
  readonly vaultPath: string;
  readonly status: StatusPayload;
  readonly doctor: DoctorPayload;
  readonly viewSchemas: ReadonlyArray<string>;
  readonly synced: boolean;
  readonly notices: ReadonlyArray<string>;
};

async function smokeVault(input: {
  readonly label: string;
  readonly vaultPath: string;
  readonly syncIfNeeded: boolean;
  readonly requireCleanAdopted: boolean;
}): Promise<VaultSmokeResult> {
  const vaultPath = resolve(input.vaultPath);
  console.log(`v1-smoke: checking ${input.label} vault at ${vaultPath}`);

  let status = await statusJson(vaultPath);
  const notices: string[] = [];
  assertOperationallyHealthy(input.label, status);

  let synced = false;
  if (input.syncIfNeeded && status.sync_needed) {
    if (status.dirty_modified > 0 || status.dirty_untracked > 0) {
      throw new Error(
        `${input.label}: refusing to sync dirty vault ` +
          `(${status.dirty_modified} modified, ${status.dirty_untracked} untracked)`,
      );
    }
    console.log(
      `v1-smoke: syncing ${input.label} (${formatPending(status.pending_commits)} pending commit(s))`,
    );
    await runDomeJson(["sync", "--vault", vaultPath, "--json"]);
    synced = true;
    status = await statusJson(vaultPath);
    assertOperationallyHealthy(input.label, status);
  }

  if (input.requireCleanAdopted && status.sync_needed) {
    throw new Error(`${input.label}: expected adopted state to catch up`);
  }

  const doctor = await doctorJson(vaultPath);
  if (doctor.status !== "ok") {
    throw new Error(
      `${input.label}: doctor status ${doctor.status} ` +
        `(${doctor.summary.errorCount} errors, ${doctor.summary.warningCount} warnings)`,
    );
  }

  const viewSchemas = await smokeUserValueViews({
    label: input.label,
    vaultPath,
  });

  if (status.attention_diagnostics > 0) {
    notices.push(`${status.attention_diagnostics} attention diagnostic(s)`);
  }
  const informationalDiagnostics =
    status.diagnostics - status.attention_diagnostics;
  if (informationalDiagnostics > 0) {
    notices.push(`${informationalDiagnostics} informational diagnostic(s)`);
  }
  if (status.questions > 0) {
    notices.push(`${status.questions} open question(s)`);
  }
  if (status.dirty_modified > 0 || status.dirty_untracked > 0) {
    notices.push(
      `${status.dirty_modified} modified / ${status.dirty_untracked} untracked draft file(s)`,
    );
  }
  if (status.sync_needed) {
    notices.push(`${formatPending(status.pending_commits)} pending commit(s)`);
  }

  return Object.freeze({
    label: input.label,
    vaultPath,
    status,
    doctor,
    viewSchemas,
    synced,
    notices: Object.freeze(notices),
  });
}

function assertOperationallyHealthy(label: string, status: StatusPayload): void {
  if (status.adopted_diverged) {
    throw new Error(`${label}: adopted ref is diverged from HEAD`);
  }
  const failures = [
    ["pending_runs", status.pending_runs],
    ["failed_runs", status.failed_runs],
    ["outbox_failed", status.outbox_failed],
    ["quarantined", status.quarantined],
  ].filter(([, value]) => value !== 0);
  if (failures.length > 0) {
    const details = failures
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    throw new Error(`${label}: operational health failed (${details})`);
  }
}

async function statusJson(vaultPath: string): Promise<StatusPayload> {
  return await runDomeJson<StatusPayload>([
    "status",
    "--vault",
    vaultPath,
    "--json",
  ]);
}

async function doctorJson(vaultPath: string): Promise<DoctorPayload> {
  return await runDomeJson<DoctorPayload>([
    "doctor",
    "--vault",
    vaultPath,
    "--json",
  ]);
}

async function smokeUserValueViews(input: {
  readonly label: string;
  readonly vaultPath: string;
}): Promise<ReadonlyArray<string>> {
  const checks = [
    {
      name: "today",
      args: ["today", "--vault", input.vaultPath, "--json"],
      schema: "dome.daily.today/v1",
    },
    {
      name: "prep",
      args: ["prep", "--vault", input.vaultPath, "--json"],
      schema: "dome.daily.prep/v1",
    },
    {
      name: "agenda",
      args: ["agenda", "--vault", input.vaultPath, "management", "--json"],
      schema: "dome.daily.agenda-with/v1",
    },
    {
      name: "query",
      args: ["query", "--vault", input.vaultPath, "management", "--json"],
      schema: "dome.search.query/v1",
    },
    {
      name: "export-context",
      args: [
        "export-context",
        "--vault",
        input.vaultPath,
        "management",
        "--json",
      ],
      schema: "dome.search.export-context/v1",
    },
  ] as const;

  const schemas: string[] = [];
  for (const check of checks) {
    const payload = await runDomeJson<Record<string, unknown>>(check.args);
    if (payload.schema !== check.schema) {
      throw new Error(
        `${input.label}: ${check.name} returned schema ` +
          `${String(payload.schema)}; expected ${check.schema}`,
      );
    }
    schemas.push(check.schema);
  }
  return Object.freeze(schemas);
}

async function runDomeJson<T>(args: ReadonlyArray<string>): Promise<T> {
  const result = await Bun.spawn({
    cmd: [resolve(repoRoot, "bin", "dome"), ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(result.stdout).text(),
    new Response(result.stderr).text(),
    result.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `bin/dome ${args.join(" ")} exited ${exitCode}${formatStderr(stderr)}`,
    );
  }
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `bin/dome ${args.join(" ")} returned non-JSON stdout: ${message}`,
    );
  }
}

function formatStderr(stderr: string): string {
  const trimmed = stderr.trim();
  return trimmed === "" ? "" : `: ${trimmed}`;
}

function formatPending(count: number | null): string {
  return count === null ? "unknown" : String(count);
}

function printSummary(results: ReadonlyArray<VaultSmokeResult>): void {
  for (const result of results) {
    const status = result.status;
    const notices =
      result.notices.length === 0 ? "none" : result.notices.join("; ");
    console.log(
      `v1-smoke: ${result.label} ok | branch ${status.branch ?? "(detached)"} ` +
        `| head ${shortOid(status.head)} | adopted ${shortOid(status.adopted)} ` +
        `| synced ${result.synced ? "yes" : "no"} ` +
        `| views ${result.viewSchemas.length} ok | notices ${notices}`,
    );
  }
}

function shortOid(oid: string | null): string {
  return oid === null ? "(none)" : oid.slice(0, 7);
}

function parseArgs(args: ReadonlyArray<string>): SmokeOptions {
  let docsVault = resolve(repoRoot, "docs");
  let workVault: string | null = resolve(homedir(), "vaults", "work");
  let syncDocs = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--sync-docs") {
      syncDocs = true;
      continue;
    }
    if (arg === "--docs-vault") {
      docsVault = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--work-vault") {
      workVault = readValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--skip-work") {
      workVault = null;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  return Object.freeze({
    docsVault,
    workVault,
    syncDocs,
  });
}

function readValue(
  args: ReadonlyArray<string>,
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp(): void {
  console.log(
    [
      "Usage: bun scripts/v1-smoke.ts [options]",
      "",
      "Options:",
      "  --sync-docs              Run dome sync against docs/ when it is behind.",
      "  --docs-vault <path>      Docs dogfood vault path (default: ./docs).",
      "  --work-vault <path>      Work vault path (default: ~/vaults/work).",
      "  --skip-work              Do not check the work vault.",
    ].join("\n"),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`v1-smoke: ${message}`);
  process.exit(1);
});
