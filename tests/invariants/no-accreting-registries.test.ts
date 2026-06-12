// Structural fence for NO_ACCRETING_REGISTRIES (docs/wiki/invariants/
// NO_ACCRETING_REGISTRIES.md): index files are renders from description:
// frontmatter and the activity log is git history, so no first-party agent
// surface may treat either as an accreting registry.
//
// Four layers, each read from the REAL artifact:
//   1. No dome.agent charter instructs log.md appends or index-file edits.
//   2. The dome.agent manifest's patch.auto grants exclude log.md and index
//      files (checked with the broker's own glob matcher, so a covering
//      pattern like "**/*.md" cannot sneak the paths back in).
//   3. The shipped-default vault-config dome.agent grant excludes them too
//      (bundle grant and every per-processor replacement grant).
//   4. The bundle-local writable-path mirrors the grant-aware tools enforce
//      at tool time exclude them.
//
// Behavioral coverage lives in tests/extensions/dome.agent/
// grant-aware-tools.test.ts (tool-time denial), tests/extensions/
// render-index.test.ts (index files are renders), and
// tests/cli/commands/log.test.ts (dome log is the activity surface).

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
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
const AGENT_BUNDLE = join(REPO_ROOT, "assets", "extensions", "dome.agent");
const CHARTER_DIR = join(AGENT_BUNDLE, "lib");

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

describe("NO_ACCRETING_REGISTRIES", () => {
  test("no dome.agent charter instructs log.md appends or index-file edits", () => {
    const charterFiles = readdirSync(CHARTER_DIR).filter(
      (f) => f.endsWith("-charter.ts") || f === "agent-preamble.ts",
    );
    expect(charterFiles.length).toBeGreaterThanOrEqual(4);

    for (const file of charterFiles) {
      const text = readFileSync(join(CHARTER_DIR, file), "utf8");

      // No tool-call-shaped writes to the frozen log or the index renders.
      expect(text, `${file} calls appendToPage on log.md`).not.toMatch(
        /appendToPage\(\s*["'`]log\.md/,
      );
      expect(text, `${file} writes log.md or index files`).not.toMatch(
        /(?:writePage|deletePage)\(\s*["'`](?:log\.md|index[-.])/,
      );

      // No prose instruction to append the log or maintain index files.
      // Line-scoped, with a negative-context allowlist so the freeze
      // vocabulary itself ("log.md is FROZEN history — nothing appends to
      // it", "never edit index files") does not trip the fence.
      for (const line of text.split("\n")) {
        const benign =
          /frozen|never|nothing|no log\.md|read-only|generated|is the catalog/i;
        if (benign.test(line)) continue;
        expect(
          line,
          `${file} instructs appending to log.md: ${line.trim()}`,
        ).not.toMatch(/append\w*[^.\n]{0,80}\blog\.md/i);
        expect(
          line,
          `${file} instructs editing index files: ${line.trim()}`,
        ).not.toMatch(
          /\b(?:edit|update|maintain|add(?: \w+){0,3} to)\b[^.\n]{0,80}\bindex(?:\.md| files?)/i,
        );
      }
    }

    // Positive pins on the replacement vocabulary, so a wholesale charter
    // rewrite cannot quietly drop the contract along with the old chore.
    const ingest = readFileSync(join(CHARTER_DIR, "ingest-charter.ts"), "utf8");
    expect(ingest).toMatch(/never edit index files/i);
    const consolidate = readFileSync(
      join(CHARTER_DIR, "consolidate-charter.ts"),
      "utf8",
    );
    expect(consolidate).toMatch(/log\.md.*frozen/is);
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
        if (processor.id === "dome.agent.preference-promotion-answer") {
          // The single-auto-writer exception covers core.md + signals only.
          expect(paths).toEqual(["core.md", "preferences/signals.md"]);
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
      if (processorId === "dome.agent.preference-promotion-answer") {
        expect(patchAuto).toEqual(["core.md", "preferences/signals.md"]);
        continue;
      }
      expectNoRegistryCoverage(
        patchAuto,
        `default-vault-config replacement grant for ${processorId}`,
      );
    }
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
