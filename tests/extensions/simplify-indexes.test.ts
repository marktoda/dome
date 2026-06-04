import { describe, expect, test } from "bun:test";

import simplifyIndexes from "../../assets/extensions/dome.markdown/processors/simplify-indexes";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("4444444444444444444444444444444444444444");
const TREE = treeOid("5555555555555555555555555555555555555555");

describe("dome.markdown.simplify-indexes", () => {
  test("adds a stable child-page block to existing small wiki indexes", async () => {
    const effects = await runSimplifyIndexes({
      "wiki/entities/index.md": "# Entities\n\nExisting context.\n",
      "wiki/entities/ada-lovelace.md": "---\nname: Ada Lovelace\n---\n\n# Ada\n",
      "wiki/entities/grace-hopper.md": "# Grace Hopper\n",
    });

    expect(effects).toHaveLength(1);
    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("auto");
    expect(patch.reason).toBe("dome.markdown: simplify small wiki index pages");
    expect(patch.changes).toHaveLength(1);
    const change = expectWriteChange(patch, 0);
    expect(String(change.path)).toBe("wiki/entities/index.md");
    expect(change.content).toBe([
      "# Entities",
      "",
      "Existing context.",
      "",
      "## Pages",
      "",
      "<!-- dome:index:start -->",
      "- [[wiki/entities/ada-lovelace|Ada Lovelace]]",
      "- [[wiki/entities/grace-hopper|Grace Hopper]]",
      "<!-- dome:index:end -->",
      "",
    ].join("\n"));
    expect(patch.sourceRefs.map((ref) => String(ref.path))).toEqual([
      "wiki/entities/index.md",
      "wiki/entities/ada-lovelace.md",
      "wiki/entities/grace-hopper.md",
    ]);
  });

  test("no-ops when rerun on its own output", async () => {
    const first = await runSimplifyIndexes({
      "wiki/concepts/index.md": "# Concepts\n",
      "wiki/concepts/first-principles.md": "# First Principles\n",
      "wiki/concepts/operational-loop.md": "# Operational Loop\n",
    });
    const content = expectWriteChange(expectPatch(first, 0), 0).content;

    const second = await runSimplifyIndexes({
      "wiki/concepts/index.md": content,
      "wiki/concepts/first-principles.md": "# First Principles\n",
      "wiki/concepts/operational-loop.md": "# Operational Loop\n",
    });

    expect(second).toHaveLength(0);
  });

  test("refreshes an existing block without rewriting human prose", async () => {
    const effects = await runSimplifyIndexes({
      "wiki/projects/index.md": [
        "# Projects",
        "",
        "Human summary.",
        "",
        "## Pages",
        "",
        "<!-- dome:index:start -->",
        "- [[wiki/projects/old-project|Old Project]]",
        "<!-- dome:index:end -->",
        "",
        "## Notes",
        "",
        "Keep this prose.",
        "",
      ].join("\n"),
      "wiki/projects/alpha.md": "# Alpha\n",
      "wiki/projects/beta.md": "# Beta\n",
    });

    const change = expectWriteChange(expectPatch(effects, 0), 0);
    expect(change.content).toContain("Human summary.");
    expect(change.content).toContain("Keep this prose.");
    expect(change.content).toContain("- [[wiki/projects/alpha|Alpha]]");
    expect(change.content).toContain("- [[wiki/projects/beta|Beta]]");
    expect(change.content).not.toContain("old-project");
    expect(change.content).toContain(
      "<!-- dome:index:end -->\n\n## Notes",
    );
  });

  test("skips generated areas, large indexes, and indexes without enough children", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 51; i += 1) {
      many[`wiki/large/page-${i}.md`] = `# Page ${i}\n`;
    }

    const effects = await runSimplifyIndexes({
      "wiki/generated/index.md": "# Generated\n",
      "wiki/generated/a.md": "# A\n",
      "wiki/generated/b.md": "# B\n",
      "wiki/solo/index.md": "# Solo\n",
      "wiki/solo/only.md": "# Only\n",
      "wiki/large/index.md": "# Large\n",
      ...many,
    });

    expect(effects).toHaveLength(0);
  });
});

async function runSimplifyIndexes(
  files: Readonly<Record<string, string>>,
): Promise<ReadonlyArray<unknown>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-simplify-indexes",
    signal: new AbortController().signal,
    input: {
      kind: "schedule",
      cron: "10 5 * * *",
      firedAt: "2026-06-02T09:10:00.000Z",
    },
  });

  return simplifyIndexes.run(ctx);
}

function fakeSnapshot(files: Readonly<Record<string, string>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path] ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) =>
      files[path] === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: "2026-06-02T09:00:00.000Z",
            lastHumanChangedAt: "2026-06-02T09:00:00.000Z",
          },
  });
}

function expectPatch(
  effects: ReadonlyArray<unknown>,
  index: number,
): PatchEffect {
  const effect = effects[index];
  if (effect === undefined) throw new Error(`expected effect at index ${index}`);
  if (typeof effect !== "object" || effect === null || !("kind" in effect)) {
    throw new Error("effect is not an object with `kind`");
  }
  if ((effect as { readonly kind: string }).kind !== "patch") {
    throw new Error(
      `expected patch effect, got ${(effect as { readonly kind: string }).kind}`,
    );
  }
  return effect as PatchEffect;
}

function expectWriteChange(
  patch: PatchEffect,
  index: number,
): Extract<PatchEffect["changes"][number], { readonly kind: "write" }> {
  const change = patch.changes[index];
  if (change === undefined) throw new Error(`expected change at index ${index}`);
  if (change.kind !== "write") {
    throw new Error(`expected write change, got ${change.kind}`);
  }
  return change;
}
