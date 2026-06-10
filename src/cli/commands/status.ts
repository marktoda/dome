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
  footer,
  headline,
  kv,
  nextActions,
  resolveCaps,
  section,
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
    printStatusText(outcome.snapshot, {
      showLoopDetails: options.loops === true,
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
 */
function printStatusText(
  s: StatusSnapshot,
  options: { readonly showLoopDetails: boolean; readonly caps: Caps },
): void {
  const caps = options.caps;
  const glance = (label: string, st: Status): KvRow => ({
    label,
    value: statusValue(st, caps),
    tone: "plain",
  });

  const head: Status = s.attention_required
    ? { tone: "warn", label: "needs attention" }
    : { tone: "ok", label: "ok" };

  const lines: string[] = [
    headline({ cmd: "status", context: basename(s.vault) }, head, caps),
  ];

  lines.push(...section("Next", nextActions(s.next_actions, caps), caps));

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
          { label: "last sync", value: s.last_sync ?? "(never)", tone: "muted" },
          { label: "runs", value: `${formatPendingRuns(s)} pending · ${s.failed_runs} failed` },
          { label: "outbox", value: `${s.outbox_pending} pending · ${s.outbox_failed} failed` },
          { label: "quarantine", value: String(s.quarantined) },
          { label: "loops", value: formatMaintenanceLoopSummaryLine(s.maintenance_loops) },
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

  const footerStatus: Status = s.attention_required
    ? { tone: "warn", label: `${s.attention.length} ${s.attention.length === 1 ? "item needs" : "items need"} attention` }
    : { tone: "ok", label: "all clear" };
  lines.push(...footer(footerStatus, caps));

  console.log(lines.join("\n"));
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
 * The launchd service line, derived through install's probe helper with the
 * injected deps. `not-installed` and `unsupported` are informational only;
 * `notLoaded` (plist present, `launchctl print` says the service is gone)
 * is the attention-worthy state — a KeepAlive agent that is not loaded
 * means the ambient compiler silently stopped.
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
