// `dome doctor` — structural integrity audit + read-only projections +
// targeted mutators. See docs/wiki/specs/cli.md §"dome doctor".
//
// Composition shape:
//   1. Open the vault.
//   2. Run every structural CHECK (read-only; accumulates violations + info).
//   3. Run any opted-in SHOW projection (read-only; appends to info).
//   4. Run any opted-in mutating action (--rebuild-index, --repair,
//      --drain-hooks, --reset-quarantined-hooks, --time-since-reconcile).
//   5. Return {exitCode, violations, info}.
//
// Each check lives in `src/cli/doctor/checks/<name>.ts` and exports a
// single `(vault) => Promise<CheckResult>`. Each --show projection lives
// in `src/cli/doctor/show/<name>.ts` and exports `(vault, …) =>
// Promise<{info}>`. Adding a new check is one new file + one entry in
// the CHECKS array below. Adding a new --show is one new file + one
// opt + one wiring.

import { openVault, type Vault } from "../../vault";
import { WORKFLOW_NAMES } from "../../workflows/workflow-name";
import { ok, type Result, type ToolError } from "../../types";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { checkFrontmatterType } from "../doctor/checks/frontmatter-type";
import { checkWikilinks } from "../doctor/checks/wikilinks";
import { checkRawImmutable } from "../doctor/checks/raw-immutable";
import { checkLogMonotonic } from "../doctor/checks/log-monotonic";
import { checkInboxStale } from "../doctor/checks/inbox-stale";
import { checkAgentsMdDrift } from "../doctor/checks/agents-md-drift";
import type { DoctorCheck } from "../doctor/checks/types";

import { showReviewQueue } from "../doctor/show/review-queue";
import { showRawCitations } from "../doctor/show/raw-citations";
import { showWorkflows } from "../doctor/show/workflows";
import { showEvents } from "../doctor/show/events";
import { showRecentHookCycles } from "../doctor/show/recent-hook-cycles";
import { showRecentActivity } from "../doctor/show/recent-activity";

export interface DoctorReport {
  exitCode: 0 | 1;
  violations: string[];
  info: string[];
}

// Optional flags for `dome doctor`. See docs/wiki/specs/cli.md §"dome doctor".
export interface DoctorOpts {
  rebuildIndex?: boolean;
  showReviewQueue?: boolean;
  showRawCitations?: boolean;
  showWorkflows?: boolean;
  showEvents?: boolean;
  showRecentHookCycles?: boolean;
  /**
   * When set, print the last N entries from `log.md` as info lines prefixed
   * with `recent:`. `null` means use the default (50). `undefined` means
   * the flag wasn't passed and no walk runs.
   */
  recentActivityN?: number | null;
  drainHooks?: boolean;
  resetQuarantinedHooks?: boolean;
  /**
   * Report how long it's been since the daemon last synced (read from
   * .dome/state/last-reconcile-mtime.txt mtime; falls back to the legacy
   * .dome/state/last-reconciled-sha.txt for vaults migrating from v0.5
   * pre-phase1+phase3 per docs/wiki/specs/adoption.md §"Migration from v0.5").
   * See docs/wiki/gotchas/daemon-off-while-vault-mutating.md.
   */
  timeSinceReconcile?: boolean;
  /**
   * When set, regenerate AGENTS.md templated sections from current config
   * while preserving the user-prose section. Per
   * docs/wiki/invariants/AGENTS_MD_IS_ORIENTATION_SURFACE.md.
   */
  repair?: boolean;
}

// Structural checks, run in declaration order on every `dome doctor` invocation.
// Adding a new check: one new file under `src/cli/doctor/checks/`, one import
// above, and one entry here. Order is preserved for stable output.
const CHECKS: ReadonlyArray<DoctorCheck> = [
  checkFrontmatterType,
  checkWikilinks,
  checkRawImmutable,
  checkLogMonotonic,
  checkInboxStale,
  checkAgentsMdDrift,
];

export async function domeDoctor(
  vaultPath: string,
  opts: DoctorOpts = {},
): Promise<Result<DoctorReport, ToolError>> {
  const res = await openVault(vaultPath);
  if (!res.ok) return res;
  const vault = res.value;

  const violations: string[] = [];
  const info: string[] = [];

  for (const check of CHECKS) {
    const r = await check(vault);
    violations.push(...r.violations);
    info.push(...r.info);
  }

  // --rebuild-index: delegate to the SDK primitive. Privileged-writer is
  // internal; the CLI consumes the public `vault.rebuildIndex` seam.
  if (opts.rebuildIndex) {
    await vault.rebuildIndex();
  }

  // Read-only --show projections. Each projection appends to `info`; none
  // change `violations`.
  if (opts.showWorkflows) {
    const r = await showWorkflows(vault);
    info.push(...r.info);
  }
  if (opts.showEvents) {
    const r = await showEvents(vault);
    info.push(...r.info);
  }

  if (opts.drainHooks) {
    await vault.drainHooks();
    info.push(`--drain-hooks: drained (async hook queue is now idle)`);
  }
  if (opts.resetQuarantinedHooks) {
    const { makeQuarantineStore } = await import("../../quarantine-store");
    const store = makeQuarantineStore(join(vault.path, ".dome", "state", "quarantined.json"));
    const before = await store.load();
    await store.clear();
    info.push(`--reset-quarantined-hooks: cleared (${before.length} handler(s) were quarantined)`);
  }
  if (opts.showRecentHookCycles) {
    const r = await showRecentHookCycles(vault);
    info.push(...r.info);
  }
  if (opts.showReviewQueue) {
    const r = await showReviewQueue(vault);
    info.push(...r.info);
  }
  if (opts.showRawCitations) {
    const r = await showRawCitations(vault);
    info.push(...r.info);
  }
  if (opts.recentActivityN !== undefined) {
    const limit = opts.recentActivityN ?? 50;
    const r = await showRecentActivity(vault, limit);
    info.push(...r.info);
  }

  if (opts.repair) {
    const { buildAgentsMdTemplated, mergeAgentsMd, buildInitialAgentsMd } = await import("../../agents-md");
    const agentsPath = join(vault.path, "AGENTS.md");
    const newTemplated = buildAgentsMdTemplated(vault.config, vault.pageTypes, [...WORKFLOW_NAMES]);
    if (existsSync(agentsPath)) {
      const existing = await Bun.file(agentsPath).text();
      const merged = mergeAgentsMd(existing, newTemplated);
      await Bun.write(agentsPath, merged);
      info.push("--repair: AGENTS.md templated sections regenerated (user-prose preserved)");
    } else {
      const fresh = buildInitialAgentsMd(vault.config, vault.pageTypes, [...WORKFLOW_NAMES]);
      await Bun.write(agentsPath, fresh);
      info.push("--repair: AGENTS.md created (was missing)");
    }
    // Also restore CLAUDE.md to the canonical shim if it's drifted or absent.
    const claudeAbsRepair = join(vault.path, "CLAUDE.md");
    const claudeCanonical = "See AGENTS.md.\n";
    if (!existsSync(claudeAbsRepair) || (await Bun.file(claudeAbsRepair).text()) !== claudeCanonical) {
      await Bun.write(claudeAbsRepair, claudeCanonical);
      info.push("--repair: CLAUDE.md shim restored to canonical content");
    }
  }

  if (opts.timeSinceReconcile) {
    // Prefer the renamed marker; fall back to the legacy SHA file for vaults
    // migrating from v0.5 pre-phase1+phase3 per docs/wiki/specs/adoption.md
    // §"Migration from v0.5". Mtime is the load-bearing signal in both files.
    const mtimePath = join(vault.path, ".dome", "state", "last-reconcile-mtime.txt");
    const legacyPath = join(vault.path, ".dome", "state", "last-reconciled-sha.txt");
    const readPath = existsSync(mtimePath) ? mtimePath : existsSync(legacyPath) ? legacyPath : null;
    if (readPath === null) {
      info.push("time-since-reconcile: never (dome sync has never run)");
    } else {
      const st = await stat(readPath);
      const ageMs = Date.now() - st.mtimeMs;
      info.push(`time-since-reconcile: ${formatAge(ageMs)} (since ${new Date(st.mtimeMs).toISOString()})`);
    }
  }

  return ok({ exitCode: violations.length === 0 ? 0 : 1, violations, info });
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)} seconds`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} minutes`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hours`;
  return `${Math.floor(ms / 86_400_000)} days`;
}

// Re-export Vault for callers that may want a typed reference (used in some
// downstream consumers of `dome doctor` infrastructure).
export type { Vault };
