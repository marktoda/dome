import { describe, expect, test } from "bun:test";

import refreshUpdated from "../../assets/extensions/dome.markdown/processors/refresh-updated";
import type { PatchEffect } from "../../src/core/effect";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");
const TREE = treeOid("3333333333333333333333333333333333333333");
const FIRED_AT = "2026-06-02T09:00:00.000Z";

describe("dome.markdown.refresh-updated", () => {
  test("patches stale managed updated dates to the schedule date", async () => {
    const effects = await runRefreshUpdated({
      files: {
        "wiki/project-alpha.md": {
          content:
            "---\n" +
            "updated: 2026-05-01\n" +
            "type: project\n" +
            "---\n" +
            "# Project Alpha\n",
          lastChangedAt: "2026-05-28T12:00:00.000Z",
        },
      },
    });

    expect(effects.length).toBe(1);
    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("auto");
    expect(patch.reason).toBe("refresh stale managed updated dates");
    expect(patch.changes).toHaveLength(1);
    expect(patch.changes[0]).toEqual(
      expect.objectContaining({
        kind: "write",
        path: "wiki/project-alpha.md",
      }),
    );
    const change = expectWriteChange(patch, 0);
    expect(change.content).toBe(
      "---\n" +
        "type: project\n" +
        "updated: 2026-06-02\n" +
        "---\n" +
        "# Project Alpha\n",
    );
    expect(patch.sourceRefs[0]?.range).toEqual({ startLine: 2, endLine: 2 });
  });

  test("ignores user-owned notes and already-current managed pages", async () => {
    const effects = await runRefreshUpdated({
      files: {
        "notes/project-alpha.md": {
          content:
            "---\n" +
            "updated: 2026-05-01\n" +
            "---\n" +
            "# Project Alpha\n",
          lastChangedAt: "2026-05-28T12:00:00.000Z",
        },
        "wiki/project-beta.md": {
          content:
            "---\n" +
            "type: project\n" +
            "updated: 2026-05-28\n" +
            "---\n" +
            "# Project Beta\n",
          lastChangedAt: "2026-05-28T12:00:00.000Z",
        },
      },
    });

    expect(effects).toHaveLength(0);
  });

  test("no-ops when rerun on its own output", async () => {
    const first = await runRefreshUpdated({
      files: {
        "wiki/project-alpha.md": {
          content:
            "---\n" +
            "type: project\n" +
            "updated: 2026-05-01\n" +
            "---\n" +
            "# Project Alpha\n",
          lastChangedAt: "2026-05-28T12:00:00.000Z",
        },
      },
    });
    const patch = expectPatch(first, 0);
    const content = expectWriteChange(patch, 0).content;

    const second = await runRefreshUpdated({
      files: {
        "wiki/project-alpha.md": {
          content,
          lastChangedAt: FIRED_AT,
        },
      },
    });

    expect(second).toHaveLength(0);
  });
});

async function runRefreshUpdated(opts: {
  readonly files: Readonly<Record<string, FileFixture>>;
}) {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(opts.files),
    changedPaths: [],
    proposal: null,
    runId: "run-refresh-updated",
    signal: new AbortController().signal,
    input: {
      kind: "schedule",
      cron: "0 5 * * *",
      firedAt: FIRED_AT,
    },
  });

  return refreshUpdated.run(ctx);
}

type FileFixture = {
  readonly content: string;
  readonly lastChangedAt: string;
};

function fakeSnapshot(files: Readonly<Record<string, FileFixture>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path]?.content ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) => {
      const file = files[path];
      return file === undefined
        ? null
        : {
            lastChangedCommit: HEAD_COMMIT,
            lastChangedAt: file.lastChangedAt,
          };
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
