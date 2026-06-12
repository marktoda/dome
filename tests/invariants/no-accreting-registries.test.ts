// Structural fence for NO_ACCRETING_REGISTRIES (docs/wiki/invariants/
// NO_ACCRETING_REGISTRIES.md): index files are renders from description:
// frontmatter and the activity log is git history, so no first-party agent
// surface may treat either as an accreting registry.
//
// The freeze contract is about ACCRETION and MODEL writes, not
// byte-immutability: deterministic source-preserving hygiene passes
// (repair-wikilinks, normalize-frontmatter, refresh-updated, the wikilink
// validators) deliberately retain covering "**/*.md" grants — a page rename
// must not strand broken links in frozen history. What the fence forbids:
//
//   1. No module in the dome.agent bundle lib instructs log.md appends or
//      index-file edits (every .ts under lib/, not just charters).
//   2. The dome.agent manifest's patch.auto grants exclude log.md and index
//      files (checked with the broker's own glob matcher, so a covering
//      pattern like "**/*.md" cannot sneak the paths back in).
//   3. The shipped-default vault-config dome.agent grant excludes them too
//      (bundle grant and every per-processor replacement grant).
//   4. The bundle-local writable-path mirrors the grant-aware tools enforce
//      at tool time exclude them.
//   5. Across EVERY first-party manifest: no processor holding model.invoke
//      may hold patch.auto covering log.md or index files; no processor of
//      any class may name log.md as a targeted patch path; and the only
//      processor that names index files as targeted patch paths is
//      dome.markdown.render-index.
//
// Behavioral coverage lives in tests/extensions/dome.agent/
// grant-aware-tools.test.ts (tool-time denial), tests/extensions/
// render-index.test.ts (index files are renders), and
// tests/cli/commands/log.test.ts (dome log is the activity surface).

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import {
  BRIEF_WRITABLE_PATHS,
} from "../../assets/extensions/dome.agent/lib/brief-tools";
import {
  CONSOLIDATE_WRITABLE_PATHS,
} from "../../assets/extensions/dome.agent/lib/consolidate-tools";
import {
  INGEST_WRITABLE_PATHS,
} from "../../assets/extensions/dome.agent/lib/ingest-tools";
import {
  SWEEP_WRITABLE_PATHS,
} from "../../assets/extensions/dome.agent/lib/sweep-tools";
import { FIRST_PARTY_EXTENSION_DEFAULTS } from "../../src/cli/default-vault-config";
import { globMatch } from "../../src/engine/core/glob-cache";
import { parseManifest } from "../../src/extensions/manifest-schema";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXTENSIONS_DIR = join(REPO_ROOT, "assets", "extensions");
const AGENT_BUNDLE = join(EXTENSIONS_DIR, "dome.agent");
const AGENT_LIB_DIR = join(AGENT_BUNDLE, "lib");

/**
 * Representative registry paths: the root index, both default category
 * shards, and an overflow shard. A patch.auto pattern set is clean only if
 * it matches none of them — checked with the broker's own matcher so a
 * broad covering glob fails the fence the same way an explicit literal
 * would.
 */
const REGISTRY_PATHS: ReadonlyArray<string> = Object.freeze([
  "log.md",
  "index.md",
  "index-entities.md",
  "index-concepts.md",
  "index-entities-2.md",
]);

const INDEX_REGISTRY_PATHS: ReadonlyArray<string> = REGISTRY_PATHS.filter(
  (path) => path !== "log.md",
);

/**
 * Control path for the targeted-vs-generic distinction: a pattern that also
 * covers an arbitrary root-level page (e.g. "**\/*.md") is a generic hygiene
 * glob whose registry coverage is by design (source-preserving passes must
 * follow renames into frozen history); a pattern that matches a registry
 * path but NOT this control (e.g. "index.md", "index-*.md", "log.md") is a
 * targeted registry grant.
 */
const GENERIC_CONTROL_PATH = "some-ordinary-page.md";

/**
 * The two-gated-writers contract for core.md (wiki/specs/preferences.md):
 * exactly these processors hold patch.auto over core.md, pinned EXACTLY, and
 * every core.md patch.auto holder must own a DISTINCT generated block name —
 * promotion-answer owns `dome.agent:promoted-preferences`, active-projects
 * owns `dome.agent:active-projects`. Adding a third writer (or widening
 * either grant) must update this table deliberately, with its own block.
 */
const CORE_MD_WRITER_GRANTS: Readonly<
  Record<string, ReadonlyArray<string>>
> = Object.freeze({
  "dome.agent.preference-promotion-answer": Object.freeze([
    "core.md",
    "preferences/signals.md",
  ]),
  "dome.agent.active-projects": Object.freeze(["core.md"]),
});

function isGenericPattern(pattern: string): boolean {
  return globMatch(pattern, GENERIC_CONTROL_PATH);
}

function expectNoRegistryCoverage(
  patterns: ReadonlyArray<string>,
  where: string,
): void {
  for (const path of REGISTRY_PATHS) {
    const covering = patterns.filter((pattern) => globMatch(pattern, path));
    expect(
      covering,
      `${where} must not grant patch.auto over ${path} (covered by: ${covering.join(", ")})`,
    ).toEqual([]);
  }
}

type ManifestProcessor = {
  readonly bundleId: string;
  readonly id: string;
  readonly hasModelInvoke: boolean;
  readonly patchAutoPaths: ReadonlyArray<string>;
};

function loadFirstPartyProcessors(): ReadonlyArray<ManifestProcessor> {
  const processors: ManifestProcessor[] = [];
  for (const entry of readdirSync(EXTENSIONS_DIR).sort()) {
    const manifestPath = join(EXTENSIONS_DIR, entry, "manifest.yaml");
    if (!existsSync(manifestPath)) continue;
    const parsed = parseManifest(parseYaml(readFileSync(manifestPath, "utf8")));
    expect(parsed.ok, `${entry}/manifest.yaml must parse`).toBe(true);
    if (!parsed.ok) continue;
    for (const processor of parsed.value.processors) {
      const patchAutoPaths: string[] = [];
      let hasModelInvoke = false;
      for (const capability of processor.capabilities) {
        if (capability.kind === "model.invoke") hasModelInvoke = true;
        if (capability.kind !== "patch.auto") continue;
        const paths = (capability as { readonly paths?: ReadonlyArray<string> })
          .paths;
        if (Array.isArray(paths)) patchAutoPaths.push(...paths);
      }
      processors.push({
        bundleId: parsed.value.id,
        id: processor.id,
        hasModelInvoke,
        patchAutoPaths,
      });
    }
  }
  return processors;
}

/**
 * Negative-cue exemption for the prose fence, tightened: a registry mention
 * is exempt only when the freeze vocabulary appears within the 40 characters
 * PRECEDING it ("never edit index files", "no appends land in log.md").
 * A trailing negation does not exempt — "Append each run summary to log.md
 * and never skip it" fails the fence.
 */
const NEGATIVE_CUE = /never|nothing|frozen|read-only|generated/i;
const REGISTRY_MENTION = /log\.md|index(?:\.md| files?)/i;

function isExemptMention(line: string, matchIndex: number, matchText: string): boolean {
  const mention = REGISTRY_MENTION.exec(matchText);
  if (mention === null) return false;
  const mentionStart = matchIndex + mention.index;
  const mentionEnd = mentionStart + mention[0].length;
  const window = line.slice(Math.max(0, mentionStart - 40), mentionEnd);
  return NEGATIVE_CUE.test(window);
}

function expectNoWriteInstruction(
  line: string,
  pattern: RegExp,
  message: string,
): void {
  const match = pattern.exec(line);
  if (match === null) return;
  expect(
    isExemptMention(line, match.index, match[0]),
    `${message}: ${line.trim()}`,
  ).toBe(true);
}

describe("NO_ACCRETING_REGISTRIES", () => {
  test("no dome.agent lib module instructs log.md appends or index-file edits", () => {
    const libFiles = readdirSync(AGENT_LIB_DIR).filter((f) => f.endsWith(".ts"));
    // Every .ts under lib/ — charters, preambles, tools, harness — not just
    // the *-charter.ts naming convention. Floor guards against the discovery
    // glob silently going empty.
    expect(libFiles.length).toBeGreaterThanOrEqual(10);

    for (const file of libFiles) {
      const text = readFileSync(join(AGENT_LIB_DIR, file), "utf8");

      // No tool-call-shaped writes to the frozen log or the index renders.
      expect(text, `${file} calls appendToPage on log.md`).not.toMatch(
        /appendToPage\(\s*["'`]log\.md/,
      );
      expect(text, `${file} writes log.md or index files`).not.toMatch(
        /(?:writePage|deletePage)\(\s*["'`](?:log\.md|index[-.])/,
      );

      // No prose instruction to append the log or maintain index files.
      // Line-scoped; the only exemption is freeze vocabulary within the 40
      // chars preceding the registry mention (see isExemptMention).
      for (const line of text.split("\n")) {
        expectNoWriteInstruction(
          line,
          /append\w*[^.\n]{0,80}\blog\.md/i,
          `${file} instructs appending to log.md`,
        );
        expectNoWriteInstruction(
          line,
          /\b(?:edit|update|maintain|add(?: \w+){0,3} to)\b[^.\n]{0,80}\bindex(?:\.md| files?)/i,
          `${file} instructs editing index files`,
        );
      }
    }

    // Positive pins on the replacement vocabulary, so a wholesale charter
    // rewrite cannot quietly drop the contract along with the old chore.
    const ingest = readFileSync(join(AGENT_LIB_DIR, "ingest-charter.ts"), "utf8");
    expect(ingest).toMatch(/never edit index files/i);
    const consolidate = readFileSync(
      join(AGENT_LIB_DIR, "consolidate-charter.ts"),
      "utf8",
    );
    expect(consolidate).toMatch(/log\.md.*frozen/is);
  });

  test("no model.invoke processor in any first-party manifest holds patch.auto over log.md or index files", () => {
    const processors = loadFirstPartyProcessors();
    const modelProcessors = processors.filter((p) => p.hasModelInvoke);
    // ingest, consolidate, brief, sweep, warden.integrity.
    expect(modelProcessors.length).toBeGreaterThanOrEqual(5);

    for (const processor of modelProcessors) {
      expectNoRegistryCoverage(
        processor.patchAutoPaths,
        `${processor.bundleId} model-class processor ${processor.id}`,
      );
    }
  });

  test("only dome.markdown.render-index names index files as targeted patch paths; nobody targets log.md", () => {
    const processors = loadFirstPartyProcessors();
    expect(processors.length).toBeGreaterThanOrEqual(10);

    let renderIndexTargets = 0;
    for (const processor of processors) {
      for (const pattern of processor.patchAutoPaths) {
        if (isGenericPattern(pattern)) continue; // hygiene glob — by design

        // log.md has no targeted patcher of any class: frozen history's only
        // legitimate writers are the generic source-preserving passes.
        expect(
          globMatch(pattern, "log.md"),
          `${processor.bundleId}/${processor.id} names log.md as a patch target via "${pattern}"`,
        ).toBe(false);

        // Index files' only targeted patcher beyond generic hygiene passes
        // is the deterministic renderer.
        const targetsIndex = INDEX_REGISTRY_PATHS.some((path) =>
          globMatch(pattern, path),
        );
        if (!targetsIndex) continue;
        expect(
          processor.id,
          `${processor.bundleId}/${processor.id} names index files as a patch target via "${pattern}" — only dome.markdown.render-index may`,
        ).toBe("dome.markdown.render-index");
        renderIndexTargets += 1;
      }
    }
    // The renderer's own grant ("index.md", "index-*.md") must stay visible
    // to this fence — if it vanishes, the exclusivity claim is untested.
    expect(renderIndexTargets).toBeGreaterThanOrEqual(2);
  });

  test("dome.agent manifest patch.auto grants exclude log.md and index files", () => {
    const parsed = parseManifest(
      parseYaml(readFileSync(join(AGENT_BUNDLE, "manifest.yaml"), "utf8")),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    let patchAutoGrants = 0;
    for (const processor of parsed.value.processors) {
      for (const capability of processor.capabilities) {
        if (capability.kind !== "patch.auto") continue;
        patchAutoGrants += 1;
        const paths = (capability as { readonly paths?: ReadonlyArray<string> })
          .paths;
        expect(Array.isArray(paths), `${processor.id} patch.auto has paths`).toBe(
          true,
        );
        const pinnedWriterGrant = CORE_MD_WRITER_GRANTS[processor.id];
        if (pinnedWriterGrant !== undefined) {
          // A gated core.md writer: grant pinned EXACTLY (two-writer table).
          expect(paths).toEqual([...pinnedWriterGrant]);
          continue;
        }
        expectNoRegistryCoverage(paths ?? [], `${processor.id} manifest grant`);
      }
    }
    // ingest, consolidate, brief, sweep, sweep-answer, promotion-answer.
    expect(patchAutoGrants).toBeGreaterThanOrEqual(5);
  });

  test("shipped-default vault config excludes log.md and index files from dome.agent patch.auto", () => {
    const agent = FIRST_PARTY_EXTENSION_DEFAULTS.find(
      (entry) => entry.id === "dome.agent",
    );
    expect(agent, "dome.agent missing from FIRST_PARTY_EXTENSION_DEFAULTS").toBeDefined();
    if (agent === undefined) return;

    const bundlePatchAuto = agent.grant["patch.auto"];
    expect(Array.isArray(bundlePatchAuto)).toBe(true);
    expectNoRegistryCoverage(
      bundlePatchAuto as ReadonlyArray<string>,
      "default-vault-config dome.agent bundle grant",
    );

    // Read access stays granted — agents orient from the index and frozen
    // log even though they never write them.
    const read = agent.grant["read"] as ReadonlyArray<string>;
    expect(read).toContain("index.md");
    expect(read).toContain("log.md");

    for (const [processorId, grant] of Object.entries(agent.processors ?? {})) {
      const patchAuto = grant["patch.auto"];
      if (!Array.isArray(patchAuto)) continue;
      const pinnedWriterGrant = CORE_MD_WRITER_GRANTS[processorId];
      if (pinnedWriterGrant !== undefined) {
        expect(patchAuto).toEqual([...pinnedWriterGrant]);
        continue;
      }
      expectNoRegistryCoverage(
        patchAuto,
        `default-vault-config replacement grant for ${processorId}`,
      );
    }
    // Both gated writers must actually appear in the shipped replacement
    // grants — if one vanishes, the exact-pin above silently stops checking.
    expect(Object.keys(agent.processors ?? {}).sort()).toEqual(
      Object.keys(CORE_MD_WRITER_GRANTS).sort(),
    );
  });

  test("grant-aware tool writable-path mirrors exclude log.md and index files", () => {
    const mirrors: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
      ["INGEST_WRITABLE_PATHS", INGEST_WRITABLE_PATHS],
      ["CONSOLIDATE_WRITABLE_PATHS", CONSOLIDATE_WRITABLE_PATHS],
      ["BRIEF_WRITABLE_PATHS", BRIEF_WRITABLE_PATHS],
      ["SWEEP_WRITABLE_PATHS", SWEEP_WRITABLE_PATHS],
    ];
    for (const [name, paths] of mirrors) {
      expectNoRegistryCoverage(paths, name);
    }
  });
});
