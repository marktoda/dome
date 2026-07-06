// dome.markdown.attic-sweep — weekly deterministic dead-stub janitor.
//
// Every 0-byte page and `Untitled 1..15.md`-shaped stub left behind by
// capture UIs is real-world debris the owner never meant to keep, but the
// engine never deletes vault content on its own initiative — this processor
// PROPOSES an archive-move (write a copy under `attic/` mirroring the
// original path, delete the original) as one `mode: "propose"` PatchEffect;
// nothing lands until the owner reviews and applies it with `dome apply`
// ([[wiki/specs/vault-layout]] §"`attic/`").
//
// Pure processor: everything through `ctx.snapshot` (listMarkdownFiles /
// readFile / getFileInfo) and `ctx.now()`. No fs, no sqlite, no git.

import { basename } from "node:path/posix";

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ExtensionConfig,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

/** Destination root for proposed archive-moves. */
export const ATTIC_PREFIX = "attic/";

/** Default `attic_min_age_days` — a candidate must be at least this old. */
export const DEFAULT_ATTIC_MIN_AGE_DAYS = 30;

/** Default `attic_max_files` — the batch cap per run, oldest candidates first. */
export const DEFAULT_ATTIC_MAX_FILES = 20;

/**
 * Default `attic_exclude_prefixes` — path prefixes the sweep never scans.
 * `attic/` (its own destination, so an applied sweep can't re-qualify),
 * `inbox/` (ephemeral intake, not dead), `meta/` and `templates/` (engine /
 * owner bookkeeping, not stubs). `wiki/dailies/` mirrors
 * `DEFAULT_DAILY_PATH_TEMPLATE`'s directory (assets/extensions/dome.daily/
 * processors/daily-types.ts) by VALUE, not by importing across the bundle
 * boundary — dome.markdown does not read dome.daily's config (the same
 * documented posture as `core.md`'s size lint, [[wiki/specs/vault-layout]]
 * §"`core.md`"), so a vault that relocates `daily_path` must add its custom
 * daily directory to `attic_exclude_prefixes` explicitly.
 */
export const DEFAULT_ATTIC_EXCLUDE_PREFIXES: ReadonlyArray<string> =
  Object.freeze(["attic/", "inbox/", "meta/", "templates/", "wiki/dailies/"]);

/** `Untitled.md`, `Untitled 1.md`, `Untitled 15.md`, ... */
const UNTITLED_RE = /^Untitled( \d+)?\.md$/;

const DAY_MS = 24 * 60 * 60 * 1000;

const atticSweep = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const excludePrefixes = atticExcludePrefixesFromConfig(ctx.extensionConfig);
    const minAgeDays = atticMinAgeDaysFromConfig(ctx.extensionConfig);
    const maxFiles = atticMaxFilesFromConfig(ctx.extensionConfig);
    const cutoffMs = ctx.now().getTime() - minAgeDays * DAY_MS;

    const paths = await ctx.snapshot.listMarkdownFiles();
    const candidates: Array<{
      readonly path: string;
      readonly content: string;
      readonly lastChangedMs: number;
    }> = [];

    for (const path of paths) {
      if (excludePrefixes.some((prefix) => path.startsWith(prefix))) continue;

      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;

      const isDeadStub =
        content.trim().length === 0 || UNTITLED_RE.test(basename(path));
      if (!isDeadStub) continue;

      const info = await ctx.snapshot.getFileInfo(path);
      // No age evidence at all: skip rather than assume stale (conservative
      // — a candidate list is only as trustworthy as its age evidence).
      if (info === null || info === undefined) continue;

      const lastChanged = info.lastHumanChangedAt ?? info.lastChangedAt;
      const lastChangedMs = Date.parse(lastChanged);
      if (Number.isNaN(lastChangedMs) || lastChangedMs > cutoffMs) continue;

      candidates.push({ path, content, lastChangedMs });
    }

    if (candidates.length === 0) return [];

    candidates.sort((a, b) => a.lastChangedMs - b.lastChangedMs);
    const selected = candidates.slice(0, maxFiles);

    const changes: FileChangeInput[] = [];
    const sourceRefs: SourceRef[] = [];
    for (const candidate of selected) {
      changes.push({
        kind: "write",
        path: ATTIC_PREFIX + candidate.path,
        content: candidate.content,
      });
      changes.push({ kind: "delete", path: candidate.path });
      sourceRefs.push(ctx.sourceRef(candidate.path));
    }

    return [
      patchEffect({
        mode: "propose",
        changes,
        reason: `dome.markdown: archive ${selected.length} dead stub file(s) to attic/`,
        sourceRefs,
      }),
    ];
  },
});

export default atticSweep;

// ----- Config resolution (degrade-not-crash) --------------------------------
// Mirrors `minClaimsFromConfig` (assets/extensions/dome.claims/processors/
// render-facts.ts): a missing or malformed value falls back to the default
// rather than throwing.

function atticExcludePrefixesFromConfig(
  config?: ExtensionConfig,
): ReadonlyArray<string> {
  const raw = config?.["attic_exclude_prefixes"];
  if (!Array.isArray(raw)) return DEFAULT_ATTIC_EXCLUDE_PREFIXES;
  const prefixes = raw.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return prefixes.length > 0
    ? Object.freeze(prefixes)
    : DEFAULT_ATTIC_EXCLUDE_PREFIXES;
}

function atticMinAgeDaysFromConfig(config?: ExtensionConfig): number {
  const raw = config?.["attic_min_age_days"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_ATTIC_MIN_AGE_DAYS;
  }
  return raw;
}

function atticMaxFilesFromConfig(config?: ExtensionConfig): number {
  const raw = config?.["attic_max_files"];
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    return DEFAULT_ATTIC_MAX_FILES;
  }
  return raw;
}
