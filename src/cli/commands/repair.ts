// cli/commands/repair: explicit, guarded vault/state repairs.
//
// `dome repair task-anchors` is intentionally narrower than `dome doctor
// --repair`: doctor remains probe-only, while this command names one concrete
// content repair and defaults to dry-run. The apply path removes every
// occurrence of a collided task anchor; the next dome.daily stamp-block-id
// run assigns each source line its own deterministic identity. Keeping an
// arbitrary first occurrence is not convergent when another line is the one
// whose path/body deterministically hashes to the collided id.

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseBlockAnchor } from "../../core/block-anchor";
import {
  duplicateTaskAnchorCollisions,
  markdownFilesForTaskAnchorScan,
  type TaskAnchorCollision,
  type TaskAnchorScanFile,
} from "../../engine/host/health";
import { openLedgerDb, type LedgerDb } from "../../ledger/db";
import { acquireOperationalWriterLease } from "../../operational-state/writer-barrier";
import {
  planRunLedgerRetention,
  pruneRunLedger,
  type PruneRunLedgerResult,
  type RunLedgerRetentionPlan,
} from "../../ledger/runs";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_OK, EX_USAGE } from "../exit-codes";
import { parsePositiveIntegerValue } from "../parse-options";

const REPAIR_SCHEMA = "dome.repair/v1";
const TASK_ANCHORS_SCHEMA = "dome.repair.task-anchors/v1";
const RUN_LEDGER_SCHEMA = "dome.repair.run-ledger/v1";
const DAY_MS = 24 * 60 * 60 * 1000;

export type RunRepairOptions = {
  readonly subject?: string | undefined;
  readonly apply?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
  readonly olderThanDays?: string | number | boolean | undefined;
  readonly vacuum?: boolean | undefined;
  readonly json?: boolean | undefined;
  readonly vault?: string | undefined;
};

export type TaskAnchorRepairChange = {
  readonly path: string;
  readonly line: number;
  readonly anchor: string;
  readonly action: "remove-duplicate-anchor";
  readonly before: string;
  readonly after: string;
};

export type TaskAnchorRepairPlan = {
  readonly collisions: ReadonlyArray<TaskAnchorCollision>;
  readonly changes: ReadonlyArray<TaskAnchorRepairChange>;
};

export async function runRepair(
  options: RunRepairOptions = {},
): Promise<number> {
  const subject = options.subject ?? "task-anchors";
  if (options.apply === true && options.dryRun === true) {
    const message = "dome repair: --apply and --dry-run conflict.";
    printRepairError({
      schema: REPAIR_SCHEMA,
      json: options.json === true,
      error: "conflicting-flags",
      message,
    });
    return EX_USAGE;
  }

  if (subject === "task-anchors") {
    return runRepairTaskAnchors(options);
  }
  if (subject === "run-ledger") {
    return runRepairRunLedger(options);
  }

  {
    const message =
      `dome repair: unknown subject '${subject}'. Supported: task-anchors, run-ledger.`;
    printRepairError({
      schema: REPAIR_SCHEMA,
      json: options.json === true,
      error: "unknown-subject",
      message,
    });
    return EX_USAGE;
  }
}

async function runRepairTaskAnchors(
  options: RunRepairOptions,
): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const files = markdownFilesForTaskAnchorScan(vaultPath);
  const plan = taskAnchorRepairPlan(files);
  const apply = options.apply === true;
  if (apply && plan.changes.length > 0) {
    await applyTaskAnchorRepairPlan(vaultPath, files, plan);
  }

  const status = plan.changes.length === 0
    ? "clean"
    : apply
      ? "applied"
      : "planned";
  if (options.json === true) {
    console.log(
      formatJson({
        schema: TASK_ANCHORS_SCHEMA,
        status,
        vault: vaultPath,
        dryRun: !apply,
        collisionCount: plan.collisions.length,
        changeCount: plan.changes.length,
        collisions: plan.collisions,
        changes: plan.changes,
      }),
    );
  } else {
    printTaskAnchorRepairText({ status, plan, apply });
  }
  return EX_OK;
}

async function runRepairRunLedger(
  options: RunRepairOptions,
): Promise<number> {
  const olderThanDays = parsePositiveIntegerValue(options.olderThanDays, null);
  if (olderThanDays === null) {
    const message =
      "dome repair run-ledger: --older-than-days is required and must be a positive integer.";
    printRepairError({
      schema: RUN_LEDGER_SCHEMA,
      json: options.json === true,
      error: "invalid-older-than-days",
      message,
    });
    return EX_USAGE;
  }
  if (options.vacuum === true && options.apply !== true) {
    const message = "dome repair run-ledger: --vacuum requires --apply.";
    printRepairError({
      schema: RUN_LEDGER_SCHEMA,
      json: options.json === true,
      error: "vacuum-without-apply",
      message,
    });
    return EX_USAGE;
  }

  const vaultPath = resolveVaultPath(options.vault);
  const cutoffIso = new Date(Date.now() - olderThanDays * DAY_MS).toISOString();
  const ledger = await openRepairLedger(vaultPath);
  if (ledger.kind === "error") {
    const message =
      `dome repair run-ledger: state open failed. The run ledger may be corrupt: ${ledger.message}`;
    printRepairError({
      schema: RUN_LEDGER_SCHEMA,
      json: options.json === true,
      error: "ledger-open-failed",
      message,
    });
    return 1;
  }

  const apply = options.apply === true;
  let plan: RunLedgerRetentionPlan;
  let result: PruneRunLedgerResult | null = null;
  try {
    if (ledger.kind === "absent") {
      plan = emptyRunLedgerRetentionPlan(cutoffIso);
    } else if (apply) {
      result = pruneRunLedger(ledger.db, {
        cutoffIso,
        vacuum: options.vacuum === true,
      });
      plan = result;
    } else {
      plan = planRunLedgerRetention(ledger.db, { cutoffIso });
    }
  } finally {
    if (ledger.kind === "open") ledger.close();
  }

  const status = plan.eligibleRuns === 0
    ? "clean"
    : apply
      ? "applied"
      : "planned";
  if (options.json === true) {
    console.log(
      formatJson({
        schema: RUN_LEDGER_SCHEMA,
        status,
        vault: vaultPath,
        dryRun: !apply,
        olderThanDays,
        cutoffIso,
        vacuum: options.vacuum === true,
        eligibleRuns: plan.eligibleRuns,
        eligibleCapabilityUses: plan.eligibleCapabilityUses,
        eligibleCostUsd: plan.eligibleCostUsd,
        oldestStartedAt: plan.oldestStartedAt,
        newestStartedAt: plan.newestStartedAt,
        statusCounts: plan.statusCounts,
        prunedRuns: result?.prunedRuns ?? 0,
        prunedCapabilityUses: result?.prunedCapabilityUses ?? 0,
        vacuumed: result?.vacuumed ?? false,
      }),
    );
  } else {
    printRunLedgerRepairText({
      status,
      plan,
      apply,
      olderThanDays,
      vacuumed: result?.vacuumed ?? false,
    });
  }
  return EX_OK;
}

export function taskAnchorRepairPlan(
  files: ReadonlyArray<TaskAnchorScanFile>,
): TaskAnchorRepairPlan {
  const collisions = duplicateTaskAnchorCollisions({ files });
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const changes: TaskAnchorRepairChange[] = [];
  for (const collision of collisions) {
    for (const occurrence of collision.occurrences) {
      const content = byPath.get(occurrence.path);
      if (content === undefined) continue;
      const line = content.split(/\r?\n/)[occurrence.line - 1];
      if (line === undefined) continue;
      const parsed = parseBlockAnchor(line);
      if (parsed === null || parsed.id !== collision.anchor) continue;
      changes.push(
        Object.freeze({
          path: occurrence.path,
          line: occurrence.line,
          anchor: collision.anchor,
          action: "remove-duplicate-anchor" as const,
          before: line,
          after: parsed.withoutAnchor,
        }),
      );
    }
  }
  return Object.freeze({
    collisions,
    changes: Object.freeze(changes),
  });
}

async function applyTaskAnchorRepairPlan(
  vaultPath: string,
  files: ReadonlyArray<TaskAnchorScanFile>,
  plan: TaskAnchorRepairPlan,
): Promise<void> {
  const contentByPath = new Map(files.map((file) => [file.path, file.content]));
  const changesByPath = new Map<string, TaskAnchorRepairChange[]>();
  for (const change of plan.changes) {
    const changes = changesByPath.get(change.path) ?? [];
    changes.push(change);
    changesByPath.set(change.path, changes);
  }

  for (const [path, changes] of changesByPath) {
    const content = contentByPath.get(path);
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    for (const change of changes) {
      const idx = change.line - 1;
      const line = lines[idx];
      if (line === undefined) continue;
      const parsed = parseBlockAnchor(line);
      if (parsed === null || parsed.id !== change.anchor) continue;
      lines[idx] = parsed.withoutAnchor;
    }
    await writeFile(join(vaultPath, path), lines.join("\n"), "utf8");
  }
}

function printTaskAnchorRepairText(input: {
  readonly status: string;
  readonly plan: TaskAnchorRepairPlan;
  readonly apply: boolean;
}): void {
  const { plan } = input;
  if (plan.changes.length === 0) {
    console.log("task anchors clean");
    return;
  }
  const mode = input.apply ? "applied" : "dry-run";
  console.log(
    `task-anchor repair ${mode}: ${plan.collisions.length} duplicate ` +
      `${plan.collisions.length === 1 ? "anchor" : "anchors"}, ` +
      `${plan.changes.length} ${plan.changes.length === 1 ? "line" : "lines"} ` +
      `${input.apply ? "changed" : "would change"}`,
  );
  for (const collision of plan.collisions) {
    console.log(
      `- ^${collision.anchor}: remove from ` +
        collision.occurrences.map((o) => `${o.path}:${o.line}`).join(", ") +
        "; the next sync assigns distinct deterministic anchors",
    );
  }
  if (!input.apply) {
    console.log("run `dome repair task-anchors --apply` to remove duplicate anchors");
  } else {
    console.log("run `dome sync` to stamp fresh anchors on repaired lines");
  }
}

type RepairLedgerOpen =
  | { readonly kind: "absent" }
  | { readonly kind: "open"; readonly db: LedgerDb; readonly close: () => void }
  | { readonly kind: "error"; readonly message: string };

async function openRepairLedger(vaultPath: string): Promise<RepairLedgerOpen> {
  const path = join(vaultPath, ".dome", "state", "runs.db");
  if (!existsSync(path)) return { kind: "absent" };
  const admission = await acquireOperationalWriterLease({ vaultPath, command: "dome-repair-run-ledger" });
  if (!admission.ok) return { kind: "error", message: admission.error.kind };
  const result = await openLedgerDb({ path });
  if (!result.ok) {
    admission.lease.close();
    return { kind: "error", message: result.error.kind };
  }
  return {
    kind: "open",
    db: result.value.db,
    close: () => { try { result.value.db.close(); } finally { admission.lease.close(); } },
  };
}

function emptyRunLedgerRetentionPlan(cutoffIso: string): RunLedgerRetentionPlan {
  return Object.freeze({
    cutoffIso,
    eligibleRuns: 0,
    eligibleCapabilityUses: 0,
    eligibleCostUsd: 0,
    oldestStartedAt: null,
    newestStartedAt: null,
    statusCounts: Object.freeze([]),
  });
}

function printRunLedgerRepairText(input: {
  readonly status: string;
  readonly plan: RunLedgerRetentionPlan;
  readonly apply: boolean;
  readonly olderThanDays: number;
  readonly vacuumed: boolean;
}): void {
  const { plan } = input;
  if (plan.eligibleRuns === 0) {
    console.log(
      `run ledger clean: 0 prunable rows older than ${input.olderThanDays} days`,
    );
    return;
  }

  const mode = input.apply ? "applied" : "dry-run";
  const action = input.apply ? "pruned" : "would prune";
  console.log(
    `run-ledger repair ${mode}: ${action} ${plan.eligibleRuns} ` +
      `${plan.eligibleRuns === 1 ? "run" : "runs"} and ` +
      `${plan.eligibleCapabilityUses} capability-use ` +
      `${plan.eligibleCapabilityUses === 1 ? "row" : "rows"} older than ` +
      `${input.olderThanDays} days`,
  );
  console.log(
    `- cutoff ${plan.cutoffIso}; oldest ${plan.oldestStartedAt ?? "-"}; ` +
      `newest ${plan.newestStartedAt ?? "-"}; cost $${plan.eligibleCostUsd.toFixed(4)}`,
  );
  if (plan.statusCounts.length > 0) {
    console.log(
      `- statuses ${plan.statusCounts.map((s) => `${s.status}:${s.runs}`).join(", ")}`,
    );
  }
  if (!input.apply) {
    console.log(
      `run \`dome repair run-ledger --older-than-days ${input.olderThanDays} --apply\` to prune these rows`,
    );
  } else if (input.vacuumed) {
    console.log("vacuumed runs.db after pruning");
  }
}

function printRepairError(opts: {
  readonly schema: string;
  readonly json: boolean;
  readonly error: string;
  readonly message: string;
}): void {
  if (opts.json) {
    console.log(
      formatJson({
        schema: opts.schema,
        status: "error",
        error: opts.error,
        message: opts.message,
      }),
    );
  } else {
    console.error(opts.message);
  }
}
