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
  addWikilinkStubRequest,
  renderWikilinkStubPage,
  stubCandidateForWikilinkTarget,
  wikilinkReplacementText,
  type WikilinkReplacement,
  type WikilinkStubRequest,
} from "./wikilinks";

import { compareStrings } from "../../../../src/core/compare";

const MAX_REPAIRED_FILES_PER_RUN = 200;

const repairWikilinks = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const markdownPaths = await ctx.snapshot.listMarkdownFiles();
    const resolver = buildWikilinkResolver(markdownPaths);
    const paths = markdownPaths.filter(isValidatableMarkdownPath).sort();
    const changes: FileChangeInput[] = [];
    const sourceRefs: SourceRef[] = [];
    const stubRequests = new Map<string, StubRequest>();

    for (const path of paths) {
      if (changes.length >= MAX_REPAIRED_FILES_PER_RUN) break;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const replacements: WikilinkReplacement[] = [];
      const replacementSourceRefs: SourceRef[] = [];
      const frontmatterEnd = frontmatterEndLine(content);

      for (const match of findWikilinks(content)) {
        const sourceRef = ctx.sourceRef(path, {
          startLine: match.line,
          endLine: match.line,
          startChar: match.startChar,
          endChar: match.endChar,
        });
        const canonicalReplacement = resolver.canonicalReplacementTarget(
          match.target,
          path,
        );
        if (canonicalReplacement !== null) {
          replacements.push({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            text: wikilinkReplacementText(match, canonicalReplacement),
          });
          replacementSourceRefs.push(sourceRef);
          continue;
        }

        if (resolver.resolve(match.target, path) !== null) continue;
        if (
          brokenWikilinkSeverity(path, match.line, frontmatterEnd) !== "warning"
        ) {
          continue;
        }

        const suggestion = resolver.suggest(match.target);
        if (suggestion.kind !== "unique") {
          if (suggestion.kind === "none") {
            const candidate = stubCandidateForWikilinkTarget(match.target);
            if (candidate !== null) {
              addWikilinkStubRequest(stubRequests, {
                candidate,
                sourcePath: path,
                sourceRef,
              });
            }
          }
          continue;
        }

        replacements.push({
          startOffset: match.startOffset,
          endOffset: match.endOffset,
          text: wikilinkReplacementText(match, suggestion.target),
        });
        replacementSourceRefs.push(sourceRef);
      }

      if (replacements.length === 0) continue;
      const repaired = applyWikilinkReplacements(content, replacements);
      if (repaired === content) continue;

      changes.push({ kind: "write", path, content: repaired });
      sourceRefs.push(...replacementSourceRefs);
    }

    const hasStubChanges = stubRequests.size > 0;
    for (const request of [...stubRequests.values()].sort((a, b) =>
      compareStrings(a.candidate.path, b.candidate.path)
    )) {
      changes.push({
        kind: "write",
        path: request.candidate.path,
        content: renderWikilinkStubPage({
          candidate: request.candidate,
          sourcePaths: request.sourcePaths,
        }),
      });
      sourceRefs.push(...request.sourceRefs);
    }

    if (changes.length === 0) return [];

    return [
      patchEffect({
        mode: "auto",
        changes,
        reason: hasStubChanges
          ? "repair obvious managed wikilinks and create source-backed stubs"
          : "repair obvious managed wikilinks",
        sourceRefs,
      }),
    ];
  },
});

export default repairWikilinks;

type StubRequest = WikilinkStubRequest<SourceRef>;
