// dome.markdown.validate-wikilinks — Phase 11d adoption-phase processor.
//
// The first first-party adoption-phase processor with real behavior: parses
// `[[wikilink]]` syntax in changed markdown files. Obvious curated-page typos
// are repaired with source-backed PatchEffects; ambiguous close matches on
// managed pages become source-backed agent-safe questions plus diagnostics;
// flexible or note-owned links remain DiagnosticEffects. User-owned note drafts
// and imported source-page bodies emit info diagnostics so they stay visible
// without routing the whole vault to attention.
//
// Per [[wiki/specs/processors]] §"Adoption phase":
//   - Deterministic: same snapshot + input → same effects (the diagnostic
//     code, message, closest-page hint, and sourceRef are pure functions of
//     the file content + the candidate snapshot's markdown set).
//   - Bounded cost: O(changed-files × wikilinks-per-file + tree-size). The
//     markdown set is materialized once per dispatch via
//     `ctx.snapshot.listMarkdownFiles()` and reused for every changed file.
//   - No LLM, no network.
//
// Per [[wiki/matrices/processor-phase-x-trigger]], adoption-phase processors
// may subscribe to `signal` triggers; we subscribe to `document.changed` (the
// markdown overlay) and `file.created` (covers newly-added paths whose
// `document.changed` may not fire if the path was added without a content
// diff — defensive).
//
// Per [[wiki/specs/effects]] §"DiagnosticEffect", `severity: "warning"` is
// recorded + surfaced in `dome status` / `dome lint` but does not block
// adoption. Broken wikilinks are a vault-hygiene finding, not a merge gate.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. Imports use relative paths into `src/`, resolved at
// runtime by Bun's dynamic-import loader (the bundle is loaded via
// `loadBundles` in `src/extensions/loader.ts`).

import { createHash } from "node:crypto";

import {
  diagnosticEffect,
  patchEffect,
  questionEffect,
  type Effect,
  type FileChangeInput,
  type QuestionEffect,
} from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import { AMBIGUOUS_WIKILINK_QUESTION_PREFIX } from "./ambiguous-wikilink-shared";
import {
  applyWikilinkReplacements,
  brokenWikilinkMessage,
  brokenWikilinkSeverity,
  buildWikilinkResolver,
  findWikilinks,
  frontmatterEndLine,
  isValidatableMarkdownPath,
  wikilinkFragmentSuffix,
  wikilinkReplacementText,
  type WikilinkReplacement,
} from "./wikilinks";

// ----- Processor ------------------------------------------------------------

const validateWikilinks: Processor = defineProcessor({
  id: "dome.markdown.validate-wikilinks",
  version: "0.3.0",
  phase: "adoption",
  triggers: [
    { kind: "signal", name: "document.changed" },
    { kind: "signal", name: "file.created" },
  ],
  capabilities: [
    { kind: "read", paths: ["**/*.md"] },
    { kind: "patch.auto", paths: ["**/*.md"] },
    { kind: "question.ask" },
  ],
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    // Materialize the candidate snapshot's markdown set once per dispatch.
    // Build the resolver once so both qualified-path and bare-name resolution
    // stay O(1) per wikilink.
    const allMarkdownPaths = await ctx.snapshot.listMarkdownFiles();
    const resolver = buildWikilinkResolver(allMarkdownPaths);

    const effects: Effect[] = [];

    // Filter changedPaths to Dome content roots. A vault may grant broad read
    // so links can resolve to historical/external markdown, but that does not
    // mean the validator should lint append-only projections or external
    // design residue during projection rebuilds.
    const changedMarkdown = ctx.changedPaths.filter(isValidatableMarkdownPath);

    for (const changedPath of changedMarkdown) {
      const content = await ctx.snapshot.readFile(changedPath);
      // `null` means the path was deleted in the candidate; skip — there's
      // nothing to parse, and the deleted file doesn't contribute wikilinks.
      // (`file.deleted` would surface as a changedPath; we don't emit
      // diagnostics for it.)
      if (content === null) continue;

      const frontmatterEnd = frontmatterEndLine(content);
      const fileMatches = findWikilinks(content);
      const replacements: WikilinkReplacement[] = [];
      const replacementSourceRefs: SourceRef[] = [];
      for (const match of fileMatches) {
        const resolved = resolver.resolve(match.target, changedPath);
        if (resolved !== null) continue;
        const suggestions = resolver.suggest(match.target);
        const suggestion =
          suggestions.kind === "unique" ? suggestions.target : null;
        const sourceRef = ctx.sourceRef(changedPath, {
          startLine: match.line,
          endLine: match.line,
          startChar: match.startChar,
          endChar: match.endChar,
        });
        const severity = brokenWikilinkSeverity(
          changedPath,
          match.line,
          frontmatterEnd,
        );

        if (severity === "warning" && suggestion !== null) {
          replacements.push({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
            text: wikilinkReplacementText(match, suggestion),
          });
          replacementSourceRefs.push(sourceRef);
          continue;
        }

        // Unresolved target -> emit a diagnostic anchored to the
        // exact span where the wikilink appears in `changedPath`. The
        // character offsets are load-bearing: they disambiguate multiple
        // wikilinks on the same line (the diagnostic dedup key is
        // (processor_id, code, proposal_id, subject_hash) where
        // subject_hash projects each SourceRef to {path, range, stableId};
        // without distinct char offsets, two broken wikilinks on one line
        // would share a subject_hash and dedupe to a single row).
        effects.push(
          diagnosticEffect({
            severity,
            code: "dome.markdown.broken-wikilink",
            message: brokenWikilinkMessage(match.target, suggestion),
            sourceRefs: [sourceRef],
          }),
        );
        if (severity === "warning" && suggestions.kind === "ambiguous") {
          effects.push(
            ambiguousWikilinkQuestion({
              target: match.target,
              changedPath,
              line: match.line,
              startChar: match.startChar,
              sourceRef,
              candidates: suggestions.targets,
            }),
          );
        }
      }

      if (replacements.length > 0) {
        const change: FileChangeInput = {
          kind: "write",
          path: changedPath,
          content: applyWikilinkReplacements(content, replacements),
        };
        effects.push(
          patchEffect({
            mode: "auto",
            changes: [change],
            reason: `dome.markdown: repair obvious wikilink target(s) in ${changedPath}`,
            sourceRefs: replacementSourceRefs,
          }),
        );
      }
    }

    return effects;
  },
});

export default validateWikilinks;

// ----- internals ------------------------------------------------------------

function ambiguousWikilinkQuestion(opts: {
  readonly target: string;
  readonly changedPath: string;
  readonly line: number;
  readonly startChar: number;
  readonly sourceRef: SourceRef;
  readonly candidates: ReadonlyArray<string>;
}): QuestionEffect {
  const candidateOptions = opts.candidates.map((candidate) =>
    wikilinkOption(candidate, opts.target)
  );
  const options = Object.freeze([...candidateOptions, "keep unresolved"]);
  const candidateLinks = candidateOptions
    .map((candidate) => `[[${candidate}]]`)
    .join(", ");
  return questionEffect({
    question:
      `Wikilink [[${opts.target}]] in ${opts.changedPath}:${opts.line} has ` +
      `multiple plausible existing targets: ${candidateLinks}. ` +
      "Choose a target only if the surrounding source text supports it; otherwise keep it unresolved.",
    options,
    sourceRefs: [opts.sourceRef],
    idempotencyKey:
      `${AMBIGUOUS_WIKILINK_QUESTION_PREFIX}${sha256([
        opts.changedPath,
        String(opts.line),
        String(opts.startChar),
        opts.target,
        candidateOptions.join("|"),
      ].join("\0"))}`,
    metadata: {
      risk: "medium",
      confidence: 0.72,
      automationPolicy: "agent-safe",
    },
  });
}

function wikilinkOption(candidate: string, rawTarget: string): string {
  return `${candidate}${wikilinkFragmentSuffix(rawTarget)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
