// dome.markdown.refresh-updated — scheduled adopted-state metadata maintenance.
//
// Adoption normalization refreshes `updated:` for files touched by an active
// Proposal. This garden processor handles the historical adopted-state backlog:
// managed pages whose existing `updated:` field already disagrees with git
// history. It writes today's date, not the historical lastChangedAt date,
// because the maintenance patch itself becomes the latest content change.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";
import { dateOnly } from "./frontmatter-dates";
import {
  frontmatterKeyLine,
  parseFrontmatter,
  reorderFrontmatterKeys,
  stringifyFrontmatter,
  updatedDateDriftsFrom,
} from "./frontmatter-normalization";
import { frontmatterLintModeForPath } from "./path-policy";

const MAX_REFRESHED_FILES_PER_RUN = 500;

const refreshUpdated = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const targetDate = targetDateFromInput(ctx.input);
    if (targetDate === null) return [];

    const changes: FileChangeInput[] = [];
    const sourceRefs: SourceRef[] = [];
    const paths = (await ctx.snapshot.listMarkdownFiles())
      .filter((path) => frontmatterLintModeForPath(path) === "required")
      .sort();

    for (const path of paths) {
      if (changes.length >= MAX_REFRESHED_FILES_PER_RUN) break;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const parsed = parseFrontmatter(content);
      if (parsed === null || parsed.currentUpdatedDate === null) continue;

      const info = await ctx.snapshot.getFileInfo(path);
      const lastChangedDate = dateOnly(info?.lastChangedAt);
      if (!updatedDateDriftsFrom(parsed.data, lastChangedDate)) continue;

      const updatedData = { ...parsed.data, updated: targetDate };
      const refreshed = stringifyFrontmatter(
        parsed.body,
        reorderFrontmatterKeys(updatedData),
      );
      if (refreshed === content) continue;

      changes.push({ kind: "write", path, content: refreshed });
      const line = frontmatterKeyLine(content, "updated") ?? 1;
      sourceRefs.push(ctx.sourceRef(path, { startLine: line, endLine: line }));
    }

    if (changes.length === 0) return [];

    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "refresh stale managed updated dates",
        sourceRefs,
      }),
    ];
  },
});

export default refreshUpdated;

function targetDateFromInput(input: unknown): string | null {
  if (
    input !== null &&
    typeof input === "object" &&
    (input as { readonly kind?: unknown }).kind === "schedule" &&
    typeof (input as { readonly firedAt?: unknown }).firedAt === "string"
  ) {
    const firedAt = new Date((input as { readonly firedAt: string }).firedAt);
    return dateOnly(firedAt);
  }

  return dateOnly(new Date());
}
