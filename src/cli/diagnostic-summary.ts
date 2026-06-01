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
  readonly omitted_groups: number;
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
  readonly omitted_groups: number;
  readonly groups: ReadonlyArray<DiagnosticMessageGroup>;
};

export type DiagnosticRepairPath = {
  readonly repair_path: string;
  readonly repair_hint: string;
};

export type DiagnosticRepairGroup = DiagnosticRepairPath & {
  readonly count: number;
  readonly attention_count: number;
  readonly first_source_refs: string;
  readonly firstSourceRefs: ReadonlyArray<SourceRef>;
};

export type DiagnosticRepairSummary = {
  readonly total: number;
  readonly group_count: number;
  readonly shown_groups: number;
  readonly omitted_groups: number;
  readonly groups: ReadonlyArray<DiagnosticRepairGroup>;
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

export function isSourceBackedDiagnostic(
  diagnostic: Pick<DiagnosticEffect, "sourceRefs">,
): boolean {
  return diagnostic.sourceRefs.length > 0;
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
    omitted_groups: Math.max(0, groups.length - limit),
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
    const key = diagnosticMessageKey(diagnostic);
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
    omitted_groups: Math.max(0, groups.length - limit),
    groups: Object.freeze(groups.slice(0, limit)),
  });
}

export function summarizeDiagnosticRepairPaths(
  diagnostics: ReadonlyArray<DiagnosticEffect>,
  limit: number,
  options: DiagnosticSummaryOptions = {},
): DiagnosticRepairSummary {
  const grouped = new Map<string, DiagnosticRepairGroup>();
  for (const diagnostic of diagnostics) {
    const repair = diagnosticRepairPath(diagnostic);
    const existing = grouped.get(repair.repair_path);
    if (existing !== undefined) {
      grouped.set(repair.repair_path, {
        ...existing,
        count: existing.count + 1,
        attention_count: existing.attention_count +
          (isAttentionDiagnostic(diagnostic) ? 1 : 0),
      });
      continue;
    }
    grouped.set(repair.repair_path, {
      ...repair,
      count: 1,
      attention_count: isAttentionDiagnostic(diagnostic) ? 1 : 0,
      first_source_refs: formatSourceRefs(
        diagnostic.sourceRefs,
        options.sourceRefs,
      ),
      firstSourceRefs: diagnostic.sourceRefs,
    });
  }

  const groups = [...grouped.values()].sort(compareDiagnosticRepairGroups);
  return Object.freeze({
    total: diagnostics.length,
    group_count: groups.length,
    shown_groups: Math.min(limit, groups.length),
    omitted_groups: Math.max(0, groups.length - limit),
    groups: Object.freeze(groups.slice(0, limit)),
  });
}

export function diagnosticRepairPath(
  diagnostic: Pick<DiagnosticEffect, "code" | "message">,
): DiagnosticRepairPath {
  if (diagnostic.code === "dome.markdown.broken-wikilink") {
    if (diagnostic.message.includes("Did you mean")) {
      return Object.freeze({
        repair_path: "link.apply-suggestion",
        repair_hint:
          "Use the suggested existing page target, or keep the link unresolved only if that uncertainty is intentional.",
      });
    }
    return Object.freeze({
      repair_path: "link.resolve-or-create",
      repair_hint:
        "Correct the wikilink target, create a real stub if the concept is intentional, or preserve the uncertainty.",
    });
  }

  if (diagnostic.code === "dome.markdown.broken-image") {
    return Object.freeze({
      repair_path: "asset.restore-or-relink",
      repair_hint:
        "Restore the referenced asset, move it to the linked path, or update the embed target.",
    });
  }

  if (
    diagnostic.code.startsWith("dome.markdown.") &&
    (
      diagnostic.code.includes("frontmatter") ||
      diagnostic.code === "dome.markdown.missing-type" ||
      diagnostic.code === "dome.markdown.type-unknown" ||
      diagnostic.code === "dome.markdown.tags-not-list" ||
      diagnostic.code === "dome.markdown.invalid-date" ||
      diagnostic.code === "dome.markdown.missing-required-field" ||
      diagnostic.code === "dome.markdown.unknown-frontmatter-field"
    )
  ) {
    return Object.freeze({
      repair_path: "frontmatter.repair",
      repair_hint:
        "Update the page frontmatter to match the configured page-type schema.",
    });
  }

  if (diagnostic.code === "dome.markdown.stale-updated") {
    return Object.freeze({
      repair_path: "metadata.refresh-updated",
      repair_hint:
        "Run the compiler with the markdown bundle enabled, or refresh the managed updated date.",
    });
  }

  if (diagnostic.code === "raw.immutable") {
    return Object.freeze({
      repair_path: "raw.revert-source-edit",
      repair_hint:
        "Preserve raw source material by reverting the raw-file mutation and writing derived notes elsewhere.",
    });
  }

  return Object.freeze({
    repair_path: "content.inspect",
    repair_hint:
      "Inspect the source refs and fix the source markdown issue described by the diagnostic.",
  });
}

export function sortDiagnosticsByMessagePriority(
  diagnostics: ReadonlyArray<DiagnosticEffect>,
): ReadonlyArray<DiagnosticEffect> {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const key = diagnosticMessageKey(diagnostic);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return Object.freeze(
    diagnostics
      .map((diagnostic, index) => Object.freeze({ diagnostic, index }))
      .sort((a, b) => {
        const severityOrder =
          SEVERITY_RANK[a.diagnostic.severity] -
          SEVERITY_RANK[b.diagnostic.severity];
        if (severityOrder !== 0) return severityOrder;

        const countOrder =
          (counts.get(diagnosticMessageKey(b.diagnostic)) ?? 0) -
          (counts.get(diagnosticMessageKey(a.diagnostic)) ?? 0);
        if (countOrder !== 0) return countOrder;

        const codeOrder = a.diagnostic.code.localeCompare(b.diagnostic.code);
        if (codeOrder !== 0) return codeOrder;

        const messageOrder = a.diagnostic.message.localeCompare(
          b.diagnostic.message,
        );
        if (messageOrder !== 0) return messageOrder;

        return a.index - b.index;
      })
      .map(({ diagnostic }) => diagnostic),
  );
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

function compareDiagnosticRepairGroups(
  a: DiagnosticRepairGroup,
  b: DiagnosticRepairGroup,
): number {
  if (b.attention_count !== a.attention_count) {
    return b.attention_count - a.attention_count;
  }
  if (b.count !== a.count) return b.count - a.count;
  return a.repair_path.localeCompare(b.repair_path);
}

function diagnosticMessageKey(
  diagnostic: Pick<DiagnosticEffect, "severity" | "code" | "message">,
): string {
  return [
    diagnostic.severity,
    diagnostic.code,
    diagnostic.message,
  ].join("\u0000");
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
