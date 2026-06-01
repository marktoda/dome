import type { DiagnosticEffect } from "../core/effect";
import type { SourceRef } from "../core/source-ref";

export type DiagnosticSeverity = "info" | "warning" | "error" | "block";

export type DiagnosticGroup = {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly count: number;
  readonly first_message: string;
  readonly first_source_refs: string;
  readonly firstSourceRefs: ReadonlyArray<SourceRef>;
};

export type DiagnosticSummary = {
  readonly total: number;
  readonly group_count: number;
  readonly shown_groups: number;
  readonly groups: ReadonlyArray<DiagnosticGroup>;
};

export type DiagnosticMessageGroup = {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly count: number;
  readonly first_source_refs: string;
  readonly firstSourceRefs: ReadonlyArray<SourceRef>;
};

export type DiagnosticMessageSummary = {
  readonly total: number;
  readonly group_count: number;
  readonly shown_groups: number;
  readonly groups: ReadonlyArray<DiagnosticMessageGroup>;
};

export type SourceRefFormatOptions = {
  readonly includeCommit?: boolean;
};

export type DiagnosticSummaryOptions = {
  readonly sourceRefs?: SourceRefFormatOptions;
};

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = {
  block: 0,
  error: 1,
  warning: 2,
  info: 3,
};

export const RECOVERY_SOURCE_REF_FORMAT: SourceRefFormatOptions = Object.freeze({
  includeCommit: false,
});

export function isAttentionDiagnostic(
  diagnostic: Pick<DiagnosticEffect, "severity">,
): boolean {
  return diagnostic.severity !== "info";
}

export function countAttentionDiagnostics(
  diagnostics: ReadonlyArray<Pick<DiagnosticEffect, "severity">>,
): number {
  return diagnostics.filter(isAttentionDiagnostic).length;
}

export function summarizeDiagnosticEffects(
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  limit: number,
  options: DiagnosticSummaryOptions = {},
): DiagnosticSummary {
  const grouped = new Map<string, DiagnosticGroup>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}\u0000${diagnostic.code}`;
    const existing = grouped.get(key);
    if (existing !== undefined) {
      grouped.set(key, {
        ...existing,
        count: existing.count + 1,
      });
      continue;
    }
    grouped.set(key, {
      severity: diagnostic.severity,
      code: diagnostic.code,
      count: 1,
      first_message: diagnostic.message,
      first_source_refs: formatSourceRefs(diagnostic.sourceRefs, options.sourceRefs),
      firstSourceRefs: diagnostic.sourceRefs,
    });
  }

  const groups = [...grouped.values()].sort(compareDiagnosticGroups);
  return Object.freeze({
    total: diagnostics.length,
    group_count: groups.length,
    shown_groups: Math.min(limit, groups.length),
    groups: Object.freeze(groups.slice(0, limit)),
  });
}

export function summarizeDiagnosticMessages(
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  limit: number,
  options: DiagnosticSummaryOptions = {},
): DiagnosticMessageSummary {
  const grouped = new Map<string, DiagnosticMessageGroup>();
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.message,
    ].join("\u0000");
    const existing = grouped.get(key);
    if (existing !== undefined) {
      grouped.set(key, {
        ...existing,
        count: existing.count + 1,
      });
      continue;
    }
    grouped.set(key, {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      count: 1,
      first_source_refs: formatSourceRefs(diagnostic.sourceRefs, options.sourceRefs),
      firstSourceRefs: diagnostic.sourceRefs,
    });
  }

  const groups = [...grouped.values()].sort(compareDiagnosticMessageGroups);
  return Object.freeze({
    total: diagnostics.length,
    group_count: groups.length,
    shown_groups: Math.min(limit, groups.length),
    groups: Object.freeze(groups.slice(0, limit)),
  });
}

export function formatSourceRefs(
  refs: ReadonlyArray<{
    readonly path: string;
    readonly commit?: string;
    readonly range?: {
      readonly startLine: number;
      readonly endLine: number;
    };
  }>,
  options: SourceRefFormatOptions = {},
): string {
  if (refs.length === 0) return "-";
  return refs.map((ref) => formatSourceRef(ref, options)).join(", ");
}

function compareDiagnosticMessageGroups(
  a: DiagnosticMessageGroup,
  b: DiagnosticMessageGroup,
): number {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  if (b.count !== a.count) return b.count - a.count;
  const codeOrder = a.code.localeCompare(b.code);
  if (codeOrder !== 0) return codeOrder;
  return a.message.localeCompare(b.message);
}

function compareDiagnosticGroups(
  a: DiagnosticGroup,
  b: DiagnosticGroup,
): number {
  if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
    return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
  }
  if (b.count !== a.count) return b.count - a.count;
  return a.code.localeCompare(b.code);
}

function formatSourceRef(ref: {
  readonly path: string;
  readonly commit?: string;
  readonly range?: {
    readonly startLine: number;
    readonly endLine: number;
  };
}, options: SourceRefFormatOptions): string {
  const range =
    ref.range === undefined
      ? ""
      : ref.range.endLine === ref.range.startLine
        ? `:${ref.range.startLine}`
        : `:${ref.range.startLine}-${ref.range.endLine}`;
  const commit =
    options.includeCommit === false || ref.commit === undefined
      ? ""
      : ` @ ${ref.commit.slice(0, 7)}`;
  return `${ref.path}${range}${commit}`;
}
