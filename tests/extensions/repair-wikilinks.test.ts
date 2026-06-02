import { describe, expect, test } from "bun:test";

import repairWikilinks from "../../assets/extensions/dome.markdown/processors/repair-wikilinks";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");
const TREE = treeOid("3333333333333333333333333333333333333333");

describe("dome.markdown.repair-wikilinks", () => {
  test("patches obvious managed wikilink repairs from adopted state", async () => {
    const effects = await runRepairWikilinks({
      "wiki/page.md": "Working with [[wiki/entities/grce-danco#Notes|Grace]].\n",
      "wiki/entities/grace-danco.md": "# Grace Danco\n",
    });

    expect(effects).toHaveLength(1);
    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("auto");
    expect(patch.reason).toBe("repair obvious managed wikilinks");
    expect(patch.changes).toHaveLength(1);
    const change = expectWriteChange(patch, 0);
    expect(String(change.path)).toBe("wiki/page.md");
    expect(change.content).toBe(
      "Working with [[wiki/entities/grace-danco#Notes|Grace]].\n",
    );
    expect(String(patch.sourceRefs[0]?.path)).toBe("wiki/page.md");
    expect(patch.sourceRefs[0]?.range).toEqual({
      startLine: 1,
      endLine: 1,
      startChar: 13,
      endChar: 53,
    });
  });

  test("does not patch ambiguous or user-owned note links", async () => {
    const effects = await runRepairWikilinks({
      "wiki/page.md": "Working with [[wiki/entities/grae-danco]].\n",
      "notes/scratch.md": "Working with [[wiki/entities/grce-danco]].\n",
      "wiki/entities/grace-danco.md": "# Grace Danco\n",
      "wiki/entities/grade-danco.md": "# Grade Danco\n",
    });

    expect(effects).toHaveLength(0);
  });

  test("no-ops when rerun on its own output", async () => {
    const first = await runRepairWikilinks({
      "wiki/page.md": "Working with [[wiki/entities/grce-danco]].\n",
      "wiki/entities/grace-danco.md": "# Grace Danco\n",
    });
    const patch = expectPatch(first, 0);
    const content = expectWriteChange(patch, 0).content;

    const second = await runRepairWikilinks({
      "wiki/page.md": content,
      "wiki/entities/grace-danco.md": "# Grace Danco\n",
    });

    expect(second).toHaveLength(0);
  });
});

async function runRepairWikilinks(
  files: Readonly<Record<string, string>>,
): Promise<ReadonlyArray<unknown>> {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(files),
    changedPaths: [],
    proposal: null,
    runId: "run-repair-wikilinks",
    signal: new AbortController().signal,
    input: {
      kind: "schedule",
      cron: "5 5 * * *",
      firedAt: "2026-06-02T09:05:00.000Z",
    },
  });

  return repairWikilinks.run(ctx);
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
