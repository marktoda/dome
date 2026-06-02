// dome.markdown.repair-wikilinks — scheduled adopted-state link maintenance.
//
// `validate-wikilinks` repairs obvious typoed links when a page is actively
// adopted. This garden processor applies the same conservative repair policy
// to historical adopted-state drift so old managed pages can converge without
// waiting for a human or foreground agent to touch each file.

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
import {
  applyWikilinkReplacements,
  brokenWikilinkSeverity,
  buildWikilinkResolver,
  findWikilinks,
  frontmatterEndLine,
  isValidatableMarkdownPath,
  wikilinkReplacementText,
  type WikilinkReplacement,
} from "./wikilinks";

const MAX_REPAIRED_FILES_PER_RUN = 200;

const repairWikilinks = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const markdownPaths = await ctx.snapshot.listMarkdownFiles();
    const resolver = buildWikilinkResolver(markdownPaths);
    const paths = markdownPaths.filter(isValidatableMarkdownPath).sort();
    const changes: FileChangeInput[] = [];
    const sourceRefs: SourceRef[] = [];

    for (const path of paths) {
      if (changes.length >= MAX_REPAIRED_FILES_PER_RUN) break;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const replacements: WikilinkReplacement[] = [];
      const replacementSourceRefs: SourceRef[] = [];
      const frontmatterEnd = frontmatterEndLine(content);

      for (const match of findWikilinks(content)) {
        if (resolver.resolve(match.target, path) !== null) continue;
        if (
          brokenWikilinkSeverity(path, match.line, frontmatterEnd) !== "warning"
        ) {
          continue;
        }

        const suggestion = resolver.suggest(match.target);
        if (suggestion.kind !== "unique") continue;

        replacements.push({
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          text: wikilinkReplacementText(match, suggestion.target),
        });
        replacementSourceRefs.push(
          ctx.sourceRef(path, {
            startLine: match.line,
            endLine: match.line,
            startChar: match.startChar,
            endChar: match.endChar,
          }),
        );
      }

      if (replacements.length === 0) continue;
      const repaired = applyWikilinkReplacements(content, replacements);
      if (repaired === content) continue;

      changes.push({ kind: "write", path, content: repaired });
      sourceRefs.push(...replacementSourceRefs);
    }

    if (changes.length === 0) return [];

    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: "repair obvious managed wikilinks",
        sourceRefs,
      }),
    ];
  },
});

export default repairWikilinks;
