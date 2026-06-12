// dome.agent.active-projects — the second gated core.md writer.
//
// Deterministic garden processor (no model): derives per-page open-loop
// tallies from the dailies and splices the rendered list into core.md's
// `dome.agent:active-projects` generated block, under the `## Active
// projects` heading the init skeleton scaffolds. Together with the
// preference-promotion answer handler (owner of `promoted-preferences`) it
// forms the two-gated-writers, block-scoped contract
// (docs/wiki/specs/preferences.md): every core.md patch.auto holder owns
// exactly one distinct generated block; owner prose and the other writer's
// block are byte-untouched.
//
// Open-loop collection reuses dome.daily's source-backed open-loop machinery
// (the same parser carry-forward writes the daily surface with — cross-bundle
// lib import per the established brief.ts → renderDailySkeleton precedent):
// each daily's `dome.daily:open-loops` block yields `- [ ] body (from
// [[page]])` items whose source page is the project candidate. Loops dedupe
// by their stable identity across dailies; a loop settled (`[x]`/`[-]`) in
// ANY daily stops counting; dailies themselves are never project pages.
//
// Posture: diff-before-emit (byte-identical core.md → zero effects); marker
// anomalies on our block → info diagnostics and NO patch (render-index's
// refuse-and-surface posture — a damaged block needs a human); absent
// core.md → zero effects (the page is owner-scaffolded by init/recipe and
// never recreated by a cron tick — recreating a deleted owner page nightly
// would be a patch-fight with the owner).

import {
  diagnosticEffect,
  patchEffect,
  type Effect,
} from "../../../../src/core/effect";
import { compareStrings } from "../../../../src/core/compare";
import { replaceGeneratedBlock } from "../../../../src/core/generated-block";
import { generatedBlockAnomalyDiagnostics } from "../../../../src/core/generated-block-diagnostics";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import {
  dailyPathSettings,
  formatDate,
  parseDailyPath,
} from "../../dome.daily/processors/daily-paths";
import {
  openLoopIdentity,
  openLoopSurfaceKey,
  openSourceBackedOpenLoopsFromMarkdown,
  settledSourceBackedOpenLoopsFromMarkdown,
} from "../../dome.daily/processors/open-loop-surface";

import {
  ACTIVE_PROJECTS_BLOCK,
  ACTIVE_PROJECTS_END,
  ACTIVE_PROJECTS_START,
  renderActiveProjects,
  type ActiveProjectItem,
} from "../lib/active-projects";
import { coreMemoryPath } from "../lib/core-memory";

/** The cap on rendered projects (the lib renders whatever it is told). */
const ACTIVE_PROJECTS_LIMIT = 5;

const ACTIVE_PROJECTS_HEADING_RE = /^## Active projects[ \t]*$/m;

const activeProjects = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const core = coreMemoryPath(ctx.extensionConfig);
    const effects: Effect[] = [];
    if (core.problem !== null) {
      // Malformed core_path degrades to the default with one warning — the
      // config-fallback temperament shared with the agent preamble.
      effects.push(
        diagnosticEffect({
          severity: "warning",
          code: "dome.agent.core-config-invalid",
          message: core.problem,
          sourceRefs: [ctx.sourceRef(core.path, { startLine: 1, endLine: 1 })],
        }),
      );
    }

    const coreContent = await ctx.snapshot.readFile(core.path);
    if (coreContent === null) return Object.freeze(effects);

    // Marker anomalies on OUR block (half-open marker, smuggled duplicate
    // pair) → surface and refuse: a damaged block needs a human, and a splice
    // that ignored the damage could strand stale lines outside the winning
    // pair. The promoted-preferences block is the other writer's concern.
    const anomalies = generatedBlockAnomalyDiagnostics({
      content: coreContent,
      path: core.path,
      code: "dome.agent.generated-block-anomaly",
      blocks: [ACTIVE_PROJECTS_BLOCK],
      sourceRef: (path, range) => ctx.sourceRef(path, range),
    });
    if (anomalies.length > 0) {
      return Object.freeze([...effects, ...anomalies]);
    }

    const collection = await collectActiveProjects(ctx);
    const block = [
      ACTIVE_PROJECTS_START,
      renderActiveProjects(collection.items, { limit: ACTIVE_PROJECTS_LIMIT }),
      ACTIVE_PROJECTS_END,
    ].join("\n");

    const next =
      replaceGeneratedBlock(
        coreContent,
        ACTIVE_PROJECTS_BLOCK.owner,
        ACTIVE_PROJECTS_BLOCK.block,
        block,
      ) ?? insertActiveProjectsBlock(coreContent, block);
    if (next === coreContent) return Object.freeze(effects);

    const renderedCount = Math.min(
      collection.items.length,
      ACTIVE_PROJECTS_LIMIT,
    );
    return Object.freeze([
      ...effects,
      patchEffect({
        mode: "auto",
        changes: [{ kind: "write", path: core.path, content: next }],
        reason: `dome.agent: refresh active-projects block (${renderedCount} projects)`,
        sourceRefs: patchSourceRefs(ctx, core.path, collection.dailyPaths),
      }),
    ]);
  },
});

export default activeProjects;

type ActiveProjectCollection = {
  readonly items: ReadonlyArray<ActiveProjectItem>;
  /** Dailies that contributed at least one counted loop (sorted). */
  readonly dailyPaths: ReadonlyArray<string>;
};

/**
 * Tally open loops per source wiki page across the dailies. Two passes over
 * the same daily set: settled identities first (a loop closed in ANY daily —
 * today's `[x]` settles yesterday's surfaced copy), then the open loops,
 * deduped by stable identity and by normalized body (the same dual-key
 * dedupe carry-forward applies), grouped by source page with the page's
 * `lastTouched` = the newest contributing daily's date.
 */
async function collectActiveProjects(
  ctx: ProcessorContext,
): Promise<ActiveProjectCollection> {
  const settings = dailyPathSettings(ctx.extensionConfig);

  const dailies: {
    readonly path: string;
    readonly date: string;
    readonly content: string;
  }[] = [];
  for (const path of [...(await ctx.snapshot.listMarkdownFiles())].sort(
    compareStrings,
  )) {
    const date = parseDailyPath(path, settings);
    if (date === null) continue;
    const content = await ctx.snapshot.readFile(path);
    if (content === null) continue;
    dailies.push({ path, date: formatDate(date), content });
  }

  const settledIdentities = new Set<string>();
  const settledSurfaceKeys = new Set<string>();
  for (const { path, content } of dailies) {
    for (const item of settledSourceBackedOpenLoopsFromMarkdown({
      path,
      content,
    })) {
      settledIdentities.add(openLoopIdentity(item));
      settledSurfaceKeys.add(openLoopSurfaceKey(item));
    }
  }

  const byPage = new Map<
    string,
    { readonly identities: Set<string>; lastTouched: string }
  >();
  const contributingDailies = new Set<string>();
  for (const { path, date, content } of dailies) {
    for (const item of openSourceBackedOpenLoopsFromMarkdown({
      path,
      content,
    })) {
      if (
        settledIdentities.has(openLoopIdentity(item)) ||
        settledSurfaceKeys.has(openLoopSurfaceKey(item))
      ) {
        continue;
      }
      // The page a loop links to is the project candidate — but a daily is a
      // log entry, never a project page.
      if (parseDailyPath(item.sourcePath, settings) !== null) continue;
      const entry = byPage.get(item.sourcePath) ?? {
        identities: new Set<string>(),
        lastTouched: date,
      };
      entry.identities.add(openLoopIdentity(item));
      if (compareStrings(date, entry.lastTouched) > 0) {
        entry.lastTouched = date;
      }
      byPage.set(item.sourcePath, entry);
      contributingDailies.add(path);
    }
  }

  const items: ActiveProjectItem[] = [...byPage.entries()].map(
    ([page, entry]) =>
      Object.freeze({
        page,
        openLoops: entry.identities.size,
        lastTouched: entry.lastTouched,
      }),
  );
  return Object.freeze({
    items: Object.freeze(items),
    dailyPaths: Object.freeze([...contributingDailies].sort(compareStrings)),
  });
}

/**
 * Placement for a not-yet-present block: under the `## Active projects`
 * heading when present (the init skeleton ships it), appended at the end
 * otherwise — the same create-under-heading shape as
 * `splicePromotedPreference`.
 */
function insertActiveProjectsBlock(content: string, block: string): string {
  const heading = ACTIVE_PROJECTS_HEADING_RE.exec(content);
  if (heading !== null && heading.index !== undefined) {
    const insertAt = heading.index + heading[0].length;
    return `${content.slice(0, insertAt)}\n\n${block}${content.slice(insertAt)}`;
  }
  return `${content.replace(/\s+$/, "")}\n\n${block}\n`;
}

function patchSourceRefs(
  ctx: ProcessorContext,
  corePath: string,
  dailyPaths: ReadonlyArray<string>,
): ReadonlyArray<SourceRef> {
  return [
    ctx.sourceRef(corePath, { startLine: 1, endLine: 1 }),
    ...dailyPaths.map((path) => ctx.sourceRef(path)),
  ];
}
