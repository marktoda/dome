// dome.markdown.stale-dates — adoption-phase date freshness diagnostics.
//
// Compares a changed markdown page's frontmatter `updated:` date with the
// git commit date that last changed that path in the candidate snapshot.
// This processor deliberately emits diagnostics only; an auto-bumping
// patcher can be added later once the page-update policy is explicit.

import matter from "gray-matter";

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

const CODE_STALE_UPDATED = "dome.markdown.stale-updated";
const MAX_DRIFT_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const staleDates: Processor = defineProcessor({
  id: "dome.markdown.stale-dates",
  version: "0.1.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
  ],
  capabilities: [{ kind: "read", paths: ["**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const diagnostics: DiagnosticEffect[] = [];
    const changedMarkdown = ctx.changedPaths.filter((p) => p.endsWith(".md"));

    for (const path of changedMarkdown) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const updated = extractUpdatedDate(content);
      if (updated === null) continue;

      const info = await ctx.snapshot.getFileInfo(path);
      if (info === null) continue;

      const committed = dateOnly(info.lastChangedAt);
      if (committed === null) continue;

      const driftDays = Math.abs(daysBetween(updated.date, committed));
      if (driftDays <= MAX_DRIFT_DAYS) continue;

      diagnostics.push(
        diagnosticEffect({
          severity: "warning",
          code: CODE_STALE_UPDATED,
          message:
            `Frontmatter \`updated:\` is ${updated.date}, but ${path} ` +
            `was last changed on ${committed}.`,
          sourceRefs: [
            ctx.sourceRef(path, {
              startLine: updated.line,
              endLine: updated.line,
            }),
          ],
        }),
      );
    }

    return diagnostics;
  },
});

export default staleDates;

type UpdatedDate = {
  readonly date: string;
  readonly line: number;
};

function extractUpdatedDate(content: string): UpdatedDate | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch {
    return null;
  }

  const date = dateOnly(parsed.data["updated"]);
  if (date === null) return null;
  const line = frontmatterKeyLine(content, "updated") ?? 1;
  return { date, line };
}

function dateOnly(value: unknown): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function frontmatterKeyLine(content: string, key: string): number | null {
  if (!content.startsWith("---")) return null;
  const lines = content.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "---" || line.trim() === "...") return null;
    if (new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`).test(line)) return i + 1;
  }
  return null;
}

function daysBetween(a: string, b: string): number {
  return Math.round(
    Math.abs(Date.parse(`${a}T00:00:00.000Z`) - Date.parse(`${b}T00:00:00.000Z`)) /
      MS_PER_DAY,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
