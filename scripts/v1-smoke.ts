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

type SyncPayload = {
  readonly status: string;
  readonly iterations?: number;
  readonly closureCommit?: string | null;
  readonly garden?: {
    readonly subProposalCount?: number;
    readonly rejectedPatchCount?: number;
    readonly diagnosticCount?: number;
  };
};

type ViewCheck = {
  readonly name: string;
  readonly args: ReadonlyArray<string>;
  readonly schema: string;
  readonly validate?: (
    label: string,
    payload: Record<string, unknown>,
  ) => void;
};

type SmokeOptions = {
  readonly docsVault: string;
  readonly workVault: string | null;
  readonly syncDocs: boolean;
};

const repoRoot = resolve(import.meta.dir, "..");
const DOME_COMMAND_TIMEOUT_MS = 120_000;

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
  readonly catchupSyncRan: boolean;
  readonly settledSync: "checked" | "skipped";
  readonly notices: ReadonlyArray<string>;
};

export type VaultSmokeSummaryInput = Pick<
  VaultSmokeResult,
  "label" | "status" | "viewSchemas" | "catchupSyncRan" | "settledSync" | "notices"
>;

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

  let catchupSyncRan = false;
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
    catchupSyncRan = true;
    status = await statusJson(vaultPath);
    assertOperationallyHealthy(input.label, status);
  }

  if (input.requireCleanAdopted && status.sync_needed) {
    throw new Error(`${input.label}: expected adopted state to catch up`);
  }

  const settled = await verifySettledSyncIfClean({
    label: input.label,
    vaultPath,
    status,
  });
  if (settled.kind === "status-updated") {
    status = settled.status;
  } else {
    notices.push(settled.notice);
  }
  const settledSync: "checked" | "skipped" =
    settled.kind === "status-updated" ? "checked" : "skipped";

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
    catchupSyncRan,
    settledSync,
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

type SettledSyncResult =
  | {
      readonly kind: "status-updated";
      readonly status: StatusPayload;
    }
  | {
      readonly kind: "skipped";
      readonly notice: string;
    };

async function verifySettledSyncIfClean(input: {
  readonly label: string;
  readonly vaultPath: string;
  readonly status: StatusPayload;
}): Promise<SettledSyncResult> {
  if (
    input.status.dirty_modified > 0 ||
    input.status.dirty_untracked > 0 ||
    input.status.sync_needed
  ) {
    return {
      kind: "skipped",
      notice: "settled sync skipped",
    };
  }

  const sync = await runDomeJson<SyncPayload>([
    "sync",
    "--vault",
    input.vaultPath,
    "--json",
  ]);
  assertSettledSync(input.label, sync);
  const status = await statusJson(input.vaultPath);
  assertOperationallyHealthy(input.label, status);
  if (status.sync_needed) {
    throw new Error(`${input.label}: settled sync left adopted state behind`);
  }
  return { kind: "status-updated", status };
}

function assertSettledSync(label: string, sync: SyncPayload): void {
  if (sync.status !== "in-sync") {
    throw new Error(
      `${label}: expected settled sync status in-sync, got ${sync.status}`,
    );
  }
  if (sync.iterations !== 0) {
    throw new Error(
      `${label}: settled sync ran ${String(sync.iterations)} iteration(s)`,
    );
  }
  if (sync.closureCommit !== null) {
    throw new Error(
      `${label}: settled sync created closure commit ${sync.closureCommit}`,
    );
  }
  const garden = sync.garden;
  if (garden === undefined) {
    throw new Error(`${label}: settled sync omitted garden summary`);
  }
  const gardenFailures = [
    ["subProposalCount", garden.subProposalCount],
    ["rejectedPatchCount", garden.rejectedPatchCount],
    ["diagnosticCount", garden.diagnosticCount],
  ].filter(([, value]) => value !== 0);
  if (gardenFailures.length > 0) {
    const details = gardenFailures
      .map(([name, value]) => `${name}=${String(value)}`)
      .join(", ");
    throw new Error(`${label}: settled sync emitted garden work (${details})`);
  }
}

async function smokeUserValueViews(input: {
  readonly label: string;
  readonly vaultPath: string;
}): Promise<ReadonlyArray<string>> {
  const checks: ReadonlyArray<ViewCheck> = [
    {
      name: "query",
      args: ["query", "--vault", input.vaultPath, "management", "--json"],
      schema: "dome.search.query/v1",
      validate: validateQueryPayload,
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
      validate: validateExportContextPayload,
    },
  ];

  const schemas: string[] = [];
  for (const check of checks) {
    const payload = await runDomeJson<Record<string, unknown>>(check.args);
    if (payload.schema !== check.schema) {
      throw new Error(
        `${input.label}: ${check.name} returned schema ` +
          `${String(payload.schema)}; expected ${check.schema}`,
      );
    }
    check.validate?.(input.label, payload);
    schemas.push(check.schema);
  }
  return Object.freeze(schemas);
}

function validateQueryPayload(
  label: string,
  payload: Record<string, unknown>,
): void {
  const matches = nonEmptyRecordArray(payload.matches, `${label}: query.matches`);
  const first = matches[0]!;
  assertNonEmptyString(first.path, `${label}: query.matches[0].path`);
  validateRanking(first.ranking, `${label}: query.matches[0].ranking`);
  validateSourceRefs(first.sourceRefs, `${label}: query.matches[0].sourceRefs`);

  const facts = optionalRecordArray(
    first.facts,
    `${label}: query.matches[0].facts`,
  );
  if (facts.length > 0) {
    validateSourceRefs(
      facts[0]!.sourceRefs,
      `${label}: query.matches[0].facts[0].sourceRefs`,
    );
  }
}

function validateExportContextPayload(
  label: string,
  payload: Record<string, unknown>,
): void {
  const overview = record(payload.overview, `${label}: export-context.overview`);
  const readFirst = nonEmptyRecordArray(
    overview.readFirst,
    `${label}: export-context.overview.readFirst`,
  );
  const firstRead = readFirst[0]!;
  assertNonEmptyString(
    firstRead.path,
    `${label}: export-context.overview.readFirst[0].path`,
  );
  validateRanking(
    firstRead.ranking,
    `${label}: export-context.overview.readFirst[0].ranking`,
  );
  validateSourceRefs(
    firstRead.sourceRefs,
    `${label}: export-context.overview.readFirst[0].sourceRefs`,
  );

  const entries = nonEmptyRecordArray(
    payload.entries,
    `${label}: export-context.entries`,
  );
  const firstEntry = entries[0]!;
  assertNonEmptyString(
    firstEntry.path,
    `${label}: export-context.entries[0].path`,
  );
  validateRanking(
    firstEntry.ranking,
    `${label}: export-context.entries[0].ranking`,
  );
  validateSourceRefs(
    firstEntry.sourceRefs,
    `${label}: export-context.entries[0].sourceRefs`,
  );

  const summary = nonEmptyRecordArray(
    firstEntry.summary,
    `${label}: export-context.entries[0].summary`,
  );
  validateSourceRefs(
    summary[0]!.sourceRefs,
    `${label}: export-context.entries[0].summary[0].sourceRefs`,
  );

  const markdown = assertNonEmptyString(
    payload.markdown,
    `${label}: export-context.markdown`,
  );
  if (!markdown.includes("SourceRefs:")) {
    throw new Error(`${label}: export-context markdown omits SourceRefs`);
  }
}

function validateRanking(value: unknown, label: string): void {
  const ranking = record(value, label);
  assertNumber(ranking.score, `${label}.score`);
  const reasons = nonEmptyStringArray(ranking.reasons, `${label}.reasons`);
  if (reasons.every((reason) => reason.trim() === "")) {
    throw new Error(`${label}.reasons contains no explanatory text`);
  }
  const signals = nonEmptyRecordArray(ranking.signals, `${label}.signals`);
  assertNonEmptyString(signals[0]!.kind, `${label}.signals[0].kind`);
}

function validateSourceRefs(value: unknown, label: string): void {
  const refs = nonEmptyRecordArray(value, label);
  assertNonEmptyString(refs[0]!.path, `${label}[0].path`);
  assertNonEmptyString(refs[0]!.commit, `${label}[0].commit`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalRecordArray(
  value: unknown,
  label: string,
): ReadonlyArray<Record<string, unknown>> {
  if (value === undefined) {
    return [];
  }
  return recordArray(value, label);
}

function nonEmptyRecordArray(
  value: unknown,
  label: string,
): ReadonlyArray<Record<string, unknown>> {
  const rows = recordArray(value, label);
  if (rows.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return rows;
}

function recordArray(
  value: unknown,
  label: string,
): ReadonlyArray<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function nonEmptyStringArray(
  value: unknown,
  label: string,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  const strings = value.map((item, index) =>
    assertNonEmptyString(item, `${label}[${index}]`),
  );
  if (strings.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return strings;
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

async function runDomeJson<T>(args: ReadonlyArray<string>): Promise<T> {
  const result = await Bun.spawn({
    cmd: [resolve(repoRoot, "bin", "dome"), ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    timeout: DOME_COMMAND_TIMEOUT_MS,
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
    console.log(formatVaultSmokeSummary(result));
  }
}

export function formatVaultSmokeSummary(
  result: VaultSmokeSummaryInput,
): string {
  const status = result.status;
  const notices =
    result.notices.length === 0 ? "none" : result.notices.join("; ");
  const adoptedCurrent =
    !status.adopted_diverged &&
    !status.sync_needed &&
    status.head !== null &&
    status.adopted === status.head;
  const catchupSyncStatus = result.catchupSyncRan
    ? "ran"
    : status.sync_needed
      ? "not run"
      : "not needed";
  return (
    `v1-smoke: ${result.label} ok | branch ${status.branch ?? "(detached)"} ` +
    `| head ${shortOid(status.head)} | adopted ${shortOid(status.adopted)} ` +
    `| adopted current ${adoptedCurrent ? "yes" : "no"} ` +
    `| catch-up sync ${catchupSyncStatus} ` +
    `| settled ${result.settledSync} ` +
    `| views ${result.viewSchemas.length} ok | notices ${notices}`
  );
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

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`v1-smoke: ${message}`);
    process.exit(1);
  });
}
