// dome.markdown.stale-dates — rebuild/check date freshness diagnostics.
//
// Compares a changed markdown page's frontmatter `updated:` date with the
// git commit date that last changed that path in the candidate snapshot.
// Active Proposals are repaired by normalize-frontmatter before convergence;
// this read-only processor remains the adopted-state/rebuild check so stale
// historical pages stay visible as informational diagnostics until they are
// touched or fixed.

import matter from "gray-matter";

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { frontmatterKeyLine } from "../lib/frontmatter-keys";
import { dateOnly, daysBetween } from "./frontmatter-dates";
import { frontmatterLintModeForPath } from "./path-policy";

const CODE_STALE_UPDATED = "dome.markdown.stale-updated";
const MAX_DRIFT_DAYS = 1;

const staleDates = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    if (!shouldDiagnoseStaleDates(ctx)) return [];

    const diagnostics: DiagnosticEffect[] = [];
    const changedMarkdown = ctx.changedPaths.filter(
      (p) => frontmatterLintModeForPath(p) === "required",
    );

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
          severity: "info",
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

function shouldDiagnoseStaleDates(ctx: ProcessorContext): boolean {
  return ctx.proposal === null || ctx.proposal.base === ctx.proposal.head;
}
