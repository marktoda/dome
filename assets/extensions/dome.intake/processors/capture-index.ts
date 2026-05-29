// dome.intake.capture-index — project generated capture metadata into facts.

import matter from "gray-matter";

import {
  diagnosticEffect,
  factEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";

import {
  capturePageItemsFromFrontmatter,
  lineForCapturePageItem,
  type CapturePageItem,
} from "./capture-page";

const PREDICATE_BY_KIND = Object.freeze({
  task: "dome.intake.task",
  followup: "dome.intake.followup",
  decision: "dome.intake.decision",
  entity: "dome.intake.entity",
  source_quote: "dome.intake.source_quote",
});

const captureIndex = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effects: Effect[] = [];
    for (const path of ctx.changedPaths.filter(isGeneratedCapturePath).sort()) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      let parsed: matter.GrayMatterFile<string>;
      try {
        parsed = matter(content);
      } catch {
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.intake.capture-index.invalid-frontmatter",
            message: `Cannot index intake facts from ${path}: frontmatter is not parseable.`,
            sourceRefs: [ctx.sourceRef(path, lineRange(1))],
          }),
        );
        continue;
      }

      const items = capturePageItemsFromFrontmatter(parsed.data.intake_items);
      if (items === null) {
        effects.push(
          diagnosticEffect({
            severity: "warning",
            code: "dome.intake.capture-index.invalid-intake-items",
            message:
              `Cannot index intake facts from ${path}: ` +
              "`intake_items` must be an array of {kind, text, confidence}.",
            sourceRefs: [ctx.sourceRef(path, lineRange(1))],
          }),
        );
        continue;
      }

      for (const item of items) {
        effects.push(factForItem(ctx, path, content, item));
      }
    }
    return Object.freeze(effects);
  },
});

export default captureIndex;

function factForItem(
  ctx: ProcessorContext,
  path: string,
  content: string,
  item: CapturePageItem,
): Effect {
  const line = lineForCapturePageItem(content, item);
  return factEffect({
    subject: { kind: "page", path },
    predicate: PREDICATE_BY_KIND[item.kind],
    object: { kind: "string", value: item.text },
    assertion: "generated",
    confidence: item.confidence,
    sourceRefs: [ctx.sourceRef(path, lineRange(line))],
  });
}

function isGeneratedCapturePath(path: string): boolean {
  return /^wiki\/generated\/intake\/[^/]+\.md$/.test(path);
}

function lineRange(
  line: number,
): { readonly startLine: number; readonly endLine: number } {
  return { startLine: line, endLine: line };
}
