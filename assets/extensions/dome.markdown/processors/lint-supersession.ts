// dome.markdown.lint-supersession — adoption-phase supersession lint
// (memory-quality M2).
//
// Enforces the two diagnosable halves of the supersession convention from
// [[wiki/specs/page-schema]] §"Supersession (ADR pattern)":
//
//   1. `dome.markdown.superseded-missing-forward-link` (warning) — a managed
//      wiki page with `status: superseded` must carry a `superseded_by:`
//      wikilink that resolves to a vault page. A flip without a forward
//      link strands readers in history with no way out.
//   2. `dome.markdown.link-to-superseded` (info) — a non-superseded page
//      wikilinking a superseded page is probably citing history as current;
//      the diagnostic hints the forward target. Links inside a
//      `## Superseded` section and frontmatter `superseded_by:` lines are
//      exempt — the supersession chain itself is never flagged.
//
// Like dome.markdown.validate-wikilinks, this is a full-readable-markdown
// inspection: flipping one page's status changes the diagnostic set of
// every *unchanged* page that links to it, so the processor re-derives
// diagnostics across the snapshot and declares
// `inspection: all-readable-markdown` so stale rows on unchanged paths are
// cleared.
//
// Per [[wiki/specs/processors]] §"Adoption phase":
//   - Deterministic: same snapshot → same diagnostics (pure functions of
//     file contents + the markdown set; no clock, no LLM, no network).
//   - Bounded cost: O(markdown-files × wikilinks-per-file); each file is
//     read once.
//   - Diagnostic-only — no patches, so the fixed-point loop converges in
//     one iteration. Warning/info severity never blocks adoption: per the
//     ADR rationale, supersession hygiene is vault attention, not a merge
//     gate.
//
// The char offsets on each link-to-superseded sourceRef are load-bearing:
// the diagnostic dedup key is (processor_id, code, proposal_id,
// subject_hash), and without distinct offsets two flagged links on one
// line would collapse to a single row (same gotcha as validate-wikilinks).
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader.

import {
  diagnosticEffect,
  type DiagnosticEffect,
  type Effect,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import { frontmatterLintModeForPath } from "./path-policy";
import {
  lineInRanges,
  pageIsSuperseded,
  readPageStatus,
  supersededSectionLineRanges,
  type PageStatusInfo,
} from "./supersession-shared";
import {
  buildWikilinkResolver,
  findWikilinks,
  frontmatterEndLine,
  isValidatableMarkdownPath,
} from "./wikilinks";

const CODE_MISSING_FORWARD_LINK =
  "dome.markdown.superseded-missing-forward-link";
const CODE_LINK_TO_SUPERSEDED = "dome.markdown.link-to-superseded";

const lintSupersession = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const allMarkdownPaths = await ctx.snapshot.listMarkdownFiles();
    const resolver = buildWikilinkResolver(allMarkdownPaths);
    const inspected = allMarkdownPaths.filter(isValidatableMarkdownPath);

    // Single read pass: content + parsed status per inspected page.
    const pages = new Map<string, { content: string; info: PageStatusInfo }>();
    for (const path of inspected) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      pages.set(path, { content, info: readPageStatus(content) });
    }

    // Superseded page → its forward target (resolved path when resolvable,
    // else as-written, else null). The forward target is the hint for
    // rule 2's diagnostics.
    const supersededForward = new Map<string, string | null>();
    for (const [path, page] of pages) {
      if (!pageIsSuperseded(page.info)) continue;
      const target = page.info.supersededBy;
      supersededForward.set(
        path,
        target === null ? null : resolver.resolve(target, path) ?? target,
      );
    }

    const diagnostics: DiagnosticEffect[] = [];

    // Rule 1 — superseded managed wiki pages need a resolvable forward link.
    for (const [path, page] of pages) {
      if (!pageIsSuperseded(page.info)) continue;
      if (frontmatterLintModeForPath(path) !== "required") continue;
      const target = page.info.supersededBy;
      if (target !== null && resolver.resolve(target, path) !== null) continue;

      const line = target === null
        ? page.info.statusLine
        : page.info.supersededByLine;
      diagnostics.push(
        diagnosticEffect({
          severity: "warning",
          code: CODE_MISSING_FORWARD_LINK,
          message: target === null
            ? `${path} is marked \`status: superseded\` but has no ` +
              "`superseded_by:` forward link. Add `superseded_by: " +
              '"[[<replacement page>]]"` so readers can find the current page.'
            : `${path} is marked \`status: superseded\` but its ` +
              `\`superseded_by:\` target [[${target}]] does not resolve to ` +
              "any markdown file in the vault.",
          sourceRefs: [
            ctx.sourceRef(path, { startLine: line, endLine: line }),
          ],
        }),
      );
    }

    // Rule 2 — live pages linking into history get an info hint.
    for (const [path, page] of pages) {
      if (pageIsSuperseded(page.info)) continue; // superseded linkers are history themselves

      const exemptRanges = supersededSectionLineRanges(page.content);
      const frontmatterEnd = frontmatterEndLine(page.content);
      const supersededByLine = page.info.supersededByLine;

      for (const link of findWikilinks(page.content)) {
        const resolved = resolver.resolve(link.target, path);
        if (resolved === null || !supersededForward.has(resolved)) continue;
        // Exemption: history context inside a `## Superseded` section.
        if (lineInRanges(link.line, exemptRanges)) continue;
        // Exemption: the frontmatter supersession chain itself.
        if (
          frontmatterEnd !== null &&
          link.line < frontmatterEnd &&
          link.line === supersededByLine
        ) {
          continue;
        }

        const forward = supersededForward.get(resolved) ?? null;
        diagnostics.push(
          diagnosticEffect({
            severity: "info",
            code: CODE_LINK_TO_SUPERSEDED,
            message:
              `[[${link.target}]] points at ${resolved}, which is marked ` +
              "superseded." +
              (forward !== null
                ? ` Current content lives at [[${forward}]].`
                : "") +
              " Link the current page, or move this link under a " +
              "`## Superseded` section if it is deliberate history context.",
            sourceRefs: [
              ctx.sourceRef(path, {
                startLine: link.line,
                endLine: link.line,
                startChar: link.startChar,
                endChar: link.endChar,
              }),
            ],
          }),
        );
      }
    }

    return diagnostics;
  },
});

export default lintSupersession;
