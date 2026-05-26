import { existsSync } from "node:fs";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Vault } from "./vault";
import type { HookEvent } from "./hook-context";
import { projectEffectToEvents } from "./event-projection";
import { currentSha, statusMatrix, readTree } from "./git";
import { ok, err, type Result, type ToolError } from "./types";

export interface ReconcileOpts {
  onEvent: (event: HookEvent) => void | Promise<void>;
}

export interface ReconcileResult {
  inboxProcessed: number;
  changedFiles: number;
  scheduledFired: number;
}

// Canonical scheduled-interval labels with their wall-clock duration in ms.
// Used by phase-3 (scheduled catchup) to decide whether to fire
// `clock.tick.<interval>` for a registered scheduled handler. Unknown labels
// yield `undefined` and are skipped.
const SCHEDULED_INTERVAL_MS = {
  minutely: 60_000,
  hourly: 3_600_000,
  daily: 86_400_000,
  weekly: 604_800_000,
} as const;

interface ScheduledEntry {
  interval: string;
  last_fire?: string;
}

/**
 * Three-phase reconciliation: inbox files -> committed/working-tree diff ->
 * scheduled catchup. Refuses to run when the underlying git repo is in a
 * dirty operational state (mid-merge, mid-rebase, mid-cherry-pick).
 */
export async function reconcile(vault: Vault, opts: ReconcileOpts): Promise<Result<ReconcileResult, ToolError>> {
  if (isDirtyGitState(vault.path)) {
    return err({
      kind: "validation",
      message: "Vault is in a dirty git state (mid-merge/rebase/cherry-pick). Resolve before reconciling.",
    });
  }

  let inboxProcessed = 0;
  let changedFiles = 0;
  let scheduledFired = 0;

  // Phase 1: inbox processing.
  const inboxRoot = join(vault.path, "inbox");
  if (existsSync(inboxRoot)) {
    const buckets = await readdir(inboxRoot, { withFileTypes: true });
    for (const b of buckets) {
      if (!b.isDirectory()) continue;
      const bucketDir = join(inboxRoot, b.name);
      const files = await readdir(bucketDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile()) continue;
        const rel = relative(vault.path, join(bucketDir, f.name));
        const events = projectEffectToEvents({ kind: "wrote-document", path: rel, diff: "[inbox]" });
        for (const e of events) {
          await opts.onEvent(e);
        }
        inboxProcessed++;
      }
    }
  }

  // Phase 2: git-diff replay since last-reconciled-sha.
  const stateDir = join(vault.path, ".dome", "state");
  await mkdir(stateDir, { recursive: true });
  const lastShaPath = join(stateDir, "last-reconciled-sha.txt");
  let lastSha: string | null = null;
  try {
    lastSha = (await readFile(lastShaPath, "utf8")).trim() || null;
  } catch {
    // first run — no prior reconciliation
  }

  const sha: string | null = await currentSha(vault.path);

  // Files changed in working tree (uncommitted).
  const matrix = await statusMatrix(vault.path);
  for (const row of matrix) {
    const [filepath, head, workdir, stage] = row;
    if (head !== workdir || workdir !== stage) {
      const events = projectEffectToEvents({ kind: "wrote-document", path: filepath, diff: "[changed]" });
      for (const e of events) {
        await opts.onEvent(e);
        changedFiles++;
      }
    }
  }
  // Files changed in committed diff since lastSha.
  if (lastSha && sha && lastSha !== sha) {
    try {
      const changed = await diffTrees(vault.path, lastSha, sha);
      for (const path of changed) {
        const events = projectEffectToEvents({ kind: "wrote-document", path, diff: "[committed]" });
        for (const e of events) {
          await opts.onEvent(e);
          changedFiles++;
        }
      }
    } catch {
      // If diffing fails (e.g., shallow clone), skip committed-diff phase.
    }
  }
  if (sha) await writeFile(lastShaPath, sha);

  // Phase 3: scheduled catchup.
  const scheduledPath = join(stateDir, "scheduled.json");
  let scheduled: Record<string, ScheduledEntry> = {};
  try {
    scheduled = JSON.parse(await readFile(scheduledPath, "utf8")) as Record<string, ScheduledEntry>;
  } catch {
    // none yet
  }
  const now = new Date();
  for (const handler of Object.keys(scheduled)) {
    const entry = scheduled[handler]!;
    const intervalMs = (SCHEDULED_INTERVAL_MS as Record<string, number>)[entry.interval];
    if (intervalMs === undefined) continue;
    const last = entry.last_fire ? new Date(entry.last_fire).getTime() : 0;
    if (now.getTime() - last >= intervalMs) {
      await opts.onEvent({ kind: `clock.tick.${entry.interval}`, ts: now.toISOString() });
      scheduled[handler] = { ...entry, last_fire: now.toISOString() };
      scheduledFired++;
    }
  }
  await writeFile(scheduledPath, JSON.stringify(scheduled, null, 2));

  return ok({ inboxProcessed, changedFiles, scheduledFired });
}

function isDirtyGitState(vaultPath: string): boolean {
  const gitDir = join(vaultPath, ".git");
  return (
    existsSync(join(gitDir, "MERGE_HEAD")) ||
    existsSync(join(gitDir, "rebase-merge")) ||
    existsSync(join(gitDir, "rebase-apply")) ||
    existsSync(join(gitDir, "CHERRY_PICK_HEAD"))
  );
}

async function diffTrees(dir: string, oldSha: string, newSha: string): Promise<string[]> {
  const oldFiles = new Map<string, string>();
  const newFiles = new Map<string, string>();
  await walkTree(dir, oldSha, "", oldFiles);
  await walkTree(dir, newSha, "", newFiles);
  const changed: string[] = [];
  const allPaths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  for (const p of allPaths) {
    if (oldFiles.get(p) !== newFiles.get(p)) changed.push(p);
  }
  return changed;
}

async function walkTree(dir: string, oid: string, prefix: string, out: Map<string, string>): Promise<void> {
  const tree = await readTree({ path: dir, oid });
  for (const entry of tree.tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === "tree") {
      await walkTree(dir, entry.oid, path, out);
    } else {
      out.set(path, entry.oid);
    }
  }
}

