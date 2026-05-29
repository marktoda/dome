// dome.intake.inbox-stale-check — warn on lingering inbox captures.

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

const STALE_INBOX_CODE = "inbox.stale";
const DEFAULT_STALE_AGE_HOURS = 168;
const MS_PER_HOUR = 60 * 60 * 1000;

const inboxStaleCheck: Processor = defineProcessor({
  id: "dome.intake.inbox-stale-check",
  version: "0.1.0",
  phase: "garden",
  triggers: [
    { kind: "schedule", cron: "0 * * * *" },
    { kind: "signal", name: "file.created", pathPattern: "inbox/**/*.md" },
    {
      kind: "signal",
      name: "document.changed",
      pathPattern: "inbox/**/*.md",
    },
    { kind: "signal", name: "file.deleted", pathPattern: "inbox/**/*.md" },
  ],
  capabilities: [{ kind: "read", paths: ["inbox/**/*.md"] }],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const now = nowFromInput(ctx.input) ?? new Date();
    const paths =
      isScheduleInput(ctx.input)
        ? await ctx.snapshot.listMarkdownFiles()
        : ctx.changedPaths;
    const diagnostics: DiagnosticEffect[] = [];

    for (const path of paths.filter(isStaleCheckPath).sort()) {
      const info = await ctx.snapshot.getFileInfo(path);
      if (info === null) continue;

      const ageHours = hoursBetween(info.lastChangedAt, now);
      if (ageHours < DEFAULT_STALE_AGE_HOURS) continue;

      diagnostics.push(
        diagnosticEffect({
          severity: "warning",
          code: STALE_INBOX_CODE,
          message:
            `${path} has been in the inbox for ${Math.floor(ageHours)} ` +
            "hour(s). Process, move, or delete it.",
          sourceRefs: [ctx.sourceRef(path, { startLine: 1, endLine: 1 })],
        }),
      );
    }

    return Object.freeze(diagnostics);
  },
});

export default inboxStaleCheck;

function isStaleCheckPath(path: string): boolean {
  if (!/^inbox\/[^/]+\/[^/]+\.md$/.test(path)) return false;
  return (
    !path.startsWith("inbox/review/") &&
    !path.startsWith("inbox/processed/")
  );
}

function isScheduleInput(input: unknown): boolean {
  return (
    input !== null &&
    typeof input === "object" &&
    (input as { readonly kind?: unknown }).kind === "schedule"
  );
}

function nowFromInput(input: unknown): Date | null {
  if (
    input === null ||
    typeof input !== "object" ||
    typeof (input as { readonly firedAt?: unknown }).firedAt !== "string"
  ) {
    return null;
  }
  const parsed = new Date((input as { readonly firedAt: string }).firedAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hoursBetween(olderIso: string, newer: Date): number {
  const olderMs = Date.parse(olderIso);
  if (Number.isNaN(olderMs)) return 0;
  return Math.max(0, (newer.getTime() - olderMs) / MS_PER_HOUR);
}
