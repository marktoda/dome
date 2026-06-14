// cli/commands/status: `dome status` — terminal rendering for the vault
// pulse. The snapshot collector (`buildStatusSnapshot`) and the snapshot
// types live in src/surface/status.ts, shared with the MCP `status` tool;
// this module owns flag handling and human-mode rendering.

import { basename } from "node:path";
import { homedir } from "node:os";

import { emitRuntimeOpenFailure } from "../command-error";
import {
  buildStatusSnapshot,
  type RunStatusOptions,
  type StatusSnapshot,
} from "../../surface/status";
import type {
  DiagnosticDispositionSummary,
  DiagnosticMessageSummary,
  DiagnosticSummary,
} from "../../surface/diagnostic-summary";
import { formatJson } from "../../surface/format";
import { formatSeverity } from "../human-output";
import {
  bullets,
  dimZeros,
  headline,
  humanizeCommand,
  kv,
  nextActions,
  relativeTime,
  resolveCaps,
  rollup,
  section,
  signalLine,
  statusValue,
  type Caps,
  type KvRow,
  type Status,
} from "../presenter";
import { freshnessTone, syncTone } from "./status-tone";
import {
  formatMaintenanceLoopDetailLines,
  formatMaintenanceLoopSummaryLine,
} from "../maintenance-loop-summary";
import type { ServiceDeps } from "../../surface/service-probe";

export type { RunStatusOptions, StatusSnapshot } from "../../surface/status";

export async function runStatus(
  options: RunStatusOptions = {},
  deps: ServiceDeps = {},
): Promise<number> {
  const outcome = await buildStatusSnapshot(options, deps);
  if (outcome.kind === "runtime-open-failed") {
    return emitRuntimeOpenFailure({
      command: "status",
      json: options.json === true,
      errorKind: outcome.errorKind,
    });
  }

  if (options.json === true) {
    console.log(formatJson(outcome.snapshot));
  } else {
    const verbose = options.verbose === true;
    printStatusText(outcome.snapshot, {
      showLoopDetails: options.loops === true,
      verbose,
      caps: resolveCaps(),
    });
  }
  return 0;
}

// ----- internals ------------------------------------------------------------

/**
 * Render the snapshot as a compact dashboard. The rows intentionally
 * group facts by the question a user is asking: where is git, what is
 * in the vault, is the engine healthy?
 *
 * Default (verbose=false): signal-only — headline + attention signals +
 * rollup of healthy categories. No section headers, no full-width rule.
 *
 * Verbose (verbose=true): full breakdown with VAULT, ENGINE, DIAGNOSTICS
 * sections. Footer/rule removed from both paths.
 */
function printStatusText(
  s: StatusSnapshot,
  options: { readonly showLoopDetails: boolean; readonly verbose: boolean; readonly caps: Caps },
): void {
  const caps = options.caps;

  const n = s.attention.length;
  const head: Status = s.attention_required
    ? { tone: "warn", label: `${n} ${n === 1 ? "item needs" : "items need"} attention` }
    : { tone: "ok", label: "healthy" };

  const lines: string[] = [
    headline({ cmd: "status", context: basename(s.vault) }, head, caps),
  ];

  if (!options.verbose) {
    // ---- Default: signal-only view ----
    if (s.attention_required) {
      // Next-action line(s)
      lines.push("");
      lines.push(
        ...nextActions(
          s.next_actions.map((a) => ({
            command: a.command === null ? null : humanizeCommand(a.command),
            description: a.description,
          })),
          caps,
        ),
      );

      // Build the set of attention categories with label+detail, and the
      // set of healthy category labels for the rollup.
      const attentionSignals = buildAttentionSignals(s, caps);
      const healthyLabels = buildHealthyLabels(s);

      lines.push("");
      for (const sig of attentionSignals) lines.push(sig);
      lines.push(rollup(healthyLabels, caps));

      lines.push("");
      lines.push(`  --verbose for full vault + engine`);
    } else {
      // All-clear: headline + one fingerprint line
      lines.push("");
      lines.push(buildFingerprintLine(s, caps));
    }
  } else {
    // ---- Verbose: full breakdown (existing sections, no footer/rule) ----
    const glance = (label: string, st: Status): KvRow => ({
      label,
      value: statusValue(st, caps),
      tone: "plain",
    });

    lines.push(
      ...section(
        "Next",
        nextActions(
          s.next_actions.map((a) => ({
            command: a.command === null ? null : humanizeCommand(a.command),
            description: a.description,
          })),
          caps,
        ),
        caps,
      ),
    );

    lines.push(
      ...section(
        "At a glance",
        kv(
          [
            glance("sync", syncTone(s)),
            glance("projection", freshnessTone(s)),
            glance("draft", draftStatus(s)),
            glance("diagnostics", diagnosticStatus(s)),
            glance("questions", countStatus(s.questions)),
            glance("serve", serveStatus(s)),
          ],
          caps,
        ),
        caps,
      ),
    );

    lines.push(
      ...section(
        "Vault",
        kv(
          [
            { label: "path", value: tildify(s.vault), tone: "muted" },
            { label: "branch", value: s.branch ?? "(detached)" },
            { label: "head", value: shortOid(s.head, "(none)"), tone: "ident" },
            { label: "adopted", value: shortOid(s.adopted, "(uninitialized)"), tone: "ident" },
            { label: "pending", value: formatPendingCommits(s.pending_commits) },
            { label: "content", value: formatContentSummary(s), tone: "muted" },
          ],
          caps,
        ),
        caps,
      ),
    );

    lines.push(
      ...section(
        "Engine",
        kv(
          [
            { label: "last sync", value: s.last_sync === null ? "(never)" : relativeTime(s.last_sync), tone: "muted" },
            { label: "runs", value: dimZeros([`${formatPendingRuns(s)} pending`, `${s.failed_runs} failed`], caps) },
            { label: "outbox", value: dimZeros([`${s.outbox_pending} pending`, `${s.outbox_failed} failed`], caps) },
            { label: "quarantine", value: String(s.quarantined) },
            { label: "loops", value: formatMaintenanceLoopSummaryLine(s.maintenance_loops, caps) },
            ...(s.service_status === "unsupported"
              ? []
              : [{ label: "service", value: formatServiceLine(s) } satisfies KvRow]),
            ...(s.model_provider_configured
              ? [{ label: "model", value: formatModelProviderLine(s) } satisfies KvRow]
              : []),
          ],
          caps,
        ),
        caps,
      ),
    );

    if (options.showLoopDetails) {
      lines.push(
        ...section("Loops", formatMaintenanceLoopDetailLines(s.maintenance_loops, caps), caps),
      );
    }

    const diagnosticTop =
      s.attention_diagnostics > 0 ? s.attention_diagnostic_summary : s.diagnostic_summary;
    const diagnosticFocus =
      s.attention_diagnostics > 0
        ? s.attention_diagnostic_message_summary
        : s.diagnostic_message_summary;
    const diagnosticDisposition =
      s.attention_diagnostics > 0
        ? s.attention_diagnostic_disposition_summary
        : s.diagnostic_disposition_summary;
    const diagnosticLines = [
      ...(diagnosticTop.groups.length > 0 ? [`top: ${formatDiagnosticTopLine(diagnosticTop)}`] : []),
      ...(diagnosticFocus.groups.length > 0 ? [`fix: ${formatDiagnosticFocusLine(diagnosticFocus)}`] : []),
      ...(diagnosticDisposition.groups.length > 0
        ? [`plan: ${formatDiagnosticDispositionLine(diagnosticDisposition)}`]
        : []),
    ];
    lines.push(...section("Diagnostics", bullets(diagnosticLines, caps), caps));
  }

  console.log(lines.join("\n"));
}

// ----- signal-only helpers --------------------------------------------------

type SignalEntry = { label: string; tone: import("../presenter").Tone; detail: string };

/**
 * Map each attention reason to a { label, tone, detail } triple. Reasons that
 * belong to the same display row (e.g. dirty_modified + dirty_untracked both
 * map to "draft") are de-duped: first occurrence wins.
 */
function attentionSignalEntries(s: StatusSnapshot, caps: Caps): ReadonlyArray<SignalEntry> {
  const seen = new Set<string>();
  const entries: SignalEntry[] = [];

  function add(label: string, tone: import("../presenter").Tone, detail: string): void {
    if (seen.has(label)) return;
    seen.add(label);
    entries.push({ label, tone, detail });
  }

  for (const reason of s.attention) {
    if (reason === "sync_needed" || reason === "adopted_ref_diverged") {
      const st = syncTone(s);
      add("sync", st.tone as import("../presenter").Tone, st.label);
    } else if (reason === "projection_stale") {
      const st = freshnessTone(s);
      add("projection", st.tone as import("../presenter").Tone, st.label);
    } else if (reason === "dirty_modified" || reason === "dirty_untracked") {
      const st = draftStatus(s);
      add("draft", st.tone as import("../presenter").Tone, st.label);
    } else if (reason === "diagnostics") {
      const st = diagnosticStatus(s);
      add("diagnostics", st.tone as import("../presenter").Tone, formatDiagnosticCount(s));
    } else if (reason === "questions") {
      add("questions", "warn", String(s.questions));
    } else if (reason === "serve_stale") {
      const st = serveStatus(s);
      add("serve", st.tone as import("../presenter").Tone, st.label);
    } else if (reason === "pending_runs" || reason === "failed_runs") {
      add("runs", "warn", dimZeros([`${formatPendingRuns(s)} pending`, `${s.failed_runs} failed`], caps));
    } else if (reason === "outbox_pending" || reason === "outbox_failed") {
      add("outbox", "warn", dimZeros([`${s.outbox_pending} pending`, `${s.outbox_failed} failed`], caps));
    } else if (reason === "quarantined") {
      add("quarantine", "warn", String(s.quarantined));
    } else if (reason === "service_not_loaded") {
      add("service", "warn", "installed, not loaded");
    } else if (reason === "model_provider_unreachable") {
      add("model", "warn", `probe ${s.model_provider_probe_status ?? "failed"}`);
    } else if (reason === "capture_loop_inactive") {
      add("inbox", "warn", "capture loop inactive");
    } else {
      // Exhaustiveness guard: any unrecognised attention code must still
      // produce a visible row so the header count never exceeds rendered rows.
      add(reason, "warn", "");
    }
  }

  return entries;
}

function buildAttentionSignals(s: StatusSnapshot, caps: Caps): ReadonlyArray<string> {
  const entries = attentionSignalEntries(s, caps);
  if (entries.length === 0) return [];
  const labelWidth = entries.reduce((m, e) => Math.max(m, e.label.length), 0);
  return entries.map((e) => signalLine(e.tone, e.label, e.detail, labelWidth, caps));
}

/**
 * Return the display labels for categories that are NOT flagged in attention.
 * We track a fixed ordered set of logical "slots"; any slot not covered by
 * attention is considered healthy.
 */
function buildHealthyLabels(s: StatusSnapshot): ReadonlyArray<string> {
  const attentionSet = new Set(s.attention);
  const healthy: string[] = [];

  const syncFlagged = attentionSet.has("sync_needed") || attentionSet.has("adopted_ref_diverged");
  if (!syncFlagged) healthy.push("sync");

  const projFlagged = attentionSet.has("projection_stale");
  if (!projFlagged) healthy.push("projection");

  const draftFlagged = attentionSet.has("dirty_modified") || attentionSet.has("dirty_untracked");
  if (!draftFlagged) healthy.push("draft");

  const diagFlagged = attentionSet.has("diagnostics");
  if (!diagFlagged) healthy.push("diagnostics");

  const qFlagged = attentionSet.has("questions");
  if (!qFlagged) healthy.push("questions");

  const serveFlagged = attentionSet.has("serve_stale");
  if (!serveFlagged && s.serve_status !== "off") healthy.push("serve");

  // For operational categories (runs, outbox, quarantine), only show in
  // healthy rollup when the vault has been synced (last_sync != null),
  // otherwise they'll all just be zeroes and add noise.
  if (s.last_sync !== null) {
    const runsFlagged = attentionSet.has("pending_runs") || attentionSet.has("failed_runs");
    if (!runsFlagged) healthy.push("runs");

    const outboxFlagged = attentionSet.has("outbox_pending") || attentionSet.has("outbox_failed");
    if (!outboxFlagged) healthy.push("outbox");
  }

  return healthy;
}

/**
 * One-line fingerprint for the all-clear state: synced time · page count · nothing pending.
 */
function buildFingerprintLine(s: StatusSnapshot, caps: Caps): string {
  const syncPart = s.last_sync !== null ? `synced ${relativeTime(s.last_sync)}` : "never synced";
  const pagesPart = `${s.content_pages} pages`;
  const pendingPart = "nothing pending";
  const detail = `${syncPart} · ${pagesPart} · ${pendingPart}`;
  return signalLine("ok", "", detail, 0, caps);
}

function formatServiceLine(s: StatusSnapshot): string {
  if (s.service_status === "loaded") return "loaded";
  if (s.service_status === "installed") {
    return "installed, not loaded (run dome restart)";
  }
  return "not installed";
}

function formatModelProviderLine(s: StatusSnapshot): string {
  if (s.model_provider_probe_status === null) {
    return "configured, unprobed (dome doctor or dome status --probe)";
  }
  return `probe ${s.model_provider_probe_status} at ${s.model_provider_probed_at ?? "(unknown)"}`;
}

function formatServe(s: StatusSnapshot): string {
  const branch =
    s.serve_branch !== null && s.serve_branch !== s.branch
      ? ` on ${s.serve_branch}`
      : "";
  return `${s.serve_status}${branch}`;
}

function draftStatus(s: StatusSnapshot): Status {
  if (s.dirty_modified === 0 && s.dirty_untracked === 0) return { tone: "ok", label: "clean" };
  return { tone: "warn", label: formatDraftSummary(s) };
}

function diagnosticStatus(s: StatusSnapshot): Status {
  return { tone: s.diagnostics > 0 ? "warn" : "ok", label: formatDiagnosticCount(s) };
}

function countStatus(n: number): Status {
  return { tone: n > 0 ? "warn" : "ok", label: String(n) };
}

function serveStatus(s: StatusSnapshot): Status {
  if (s.serve_status === "off") return { tone: "muted", label: "off" };
  if (s.serve_status === "stale") return { tone: "warn", label: formatServe(s) };
  return { tone: "ok", label: formatServe(s) };
}

function tildify(path: string): string {
  const home = homedir();
  if (path === home || path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function formatPendingRuns(s: StatusSnapshot): string {
  if (s.pending_runs === 0) return "0";
  if (s.orphan_runs === 0) return `${s.pending_runs} live`;
  if (s.orphan_runs === s.pending_runs) return `${s.pending_runs} stale`;
  return `${s.pending_runs} total (${s.orphan_runs} stale)`;
}

function formatDraftSummary(s: StatusSnapshot): string {
  if (s.dirty_modified === 0 && s.dirty_untracked === 0) return "clean";
  return `${s.dirty_modified} modified · ${s.dirty_untracked} untracked`;
}

function formatDiagnosticCount(s: StatusSnapshot): string {
  if (s.diagnostics === 0) return "0";
  const attention = `${s.attention_diagnostics} attention`;
  const unlocated = s.unlocated_diagnostics === 0
    ? ""
    : `, ${s.unlocated_diagnostics} unlocated`;
  return `${s.diagnostics} (${attention}${unlocated})`;
}

function formatInboxPages(s: StatusSnapshot): string {
  if (s.inbox_raw_pages === 0) return String(s.inbox_pages);
  return `${s.inbox_pages} (${s.inbox_raw_pages} raw)`;
}

function formatContentSummary(s: StatusSnapshot): string {
  return `${s.content_pages} pages · wiki ${s.wiki_pages} · notes ${s.notes_pages} · inbox ${formatInboxPages(s)} · links ${s.wikilinks} · raw ${s.raw_files} files (${formatBytes(s.raw_bytes)})`;
}

/**
 * The ambient-service line (launchd/systemd), derived through install's
 * probe helper with the injected deps. `not-installed` and `unsupported`
 * are informational only; `notLoaded` (service file present, the live
 * probe says the service is gone) is the attention-worthy state — a
 * keep-alive service that is not loaded means the ambient compiler
 * silently stopped.
 */
function formatDiagnosticTopLine(summary: DiagnosticSummary): string {
  return summary.groups
    .map((group) => `${group.count} ${formatSeverity(group.severity)} ${group.code}`)
    .join(" · ");
}

function formatDiagnosticFocusLine(summary: DiagnosticMessageSummary): string {
  const maxGroups = 2;
  const groups = summary.groups.slice(0, maxGroups);
  const lines = groups.map((group) =>
    `${group.count} ${formatSeverity(group.severity)} ${group.code}: ` +
      truncateStatusMessage(group.message)
  );
  const remaining = summary.group_count - groups.length;
  if (remaining > 0) lines.push(`+${remaining} more`);
  return lines.join(" · ");
}

function formatDiagnosticDispositionLine(
  summary: DiagnosticDispositionSummary,
): string {
  const counts = new Map<string, number>();
  for (const group of summary.groups) {
    counts.set(
      group.disposition,
      (counts.get(group.disposition) ?? 0) + group.count,
    );
  }
  return [...counts]
    .map(([disposition, count]) => `${count} ${disposition}`)
    .join(" · ");
}

function truncateStatusMessage(message: string): string {
  const maxLength = 80;
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 3)}...`;
}

function shortOid(oid: string | null, fallback: string): string {
  return oid === null ? fallback : oid.slice(0, 7);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MB`;
  return `${(mib / 1024).toFixed(1)} GB`;
}

function formatPendingCommits(count: number | null): string {
  return count === null ? "unknown" : String(count);
}
