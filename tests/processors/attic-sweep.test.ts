import { describe, expect, test } from "bun:test";

import atticSweep, {
  ATTIC_PREFIX,
  DEFAULT_ATTIC_MAX_FILES,
  DEFAULT_ATTIC_MIN_AGE_DAYS,
} from "../../assets/extensions/dome.markdown/processors/attic-sweep";
import type { PatchEffect } from "../../src/core/effect";
import type { ExtensionConfig } from "../../src/core/processor";
import { treeOid, type Snapshot } from "../../src/core/processor";
import { commitOid } from "../../src/core/source-ref";
import { makeProcessorContext } from "../../src/processors/context";

const HEAD_COMMIT = commitOid("2222222222222222222222222222222222222222");
const TREE = treeOid("3333333333333333333333333333333333333333");
const NOW = "2026-07-06T09:00:00.000Z";

describe("dome.markdown.attic-sweep", () => {
  test("archives an old empty file and an old Untitled stub in one propose patch", async () => {
    const effects = await runAtticSweep({
      files: {
        "notes/empty.md": {
          content: "",
          lastChangedAt: daysBeforeNow(40),
        },
        "notes/Untitled 3.md": {
          content: "Untitled 3\n",
          lastChangedAt: daysBeforeNow(35),
        },
      },
    });

    expect(effects).toHaveLength(1);
    const patch = expectPatch(effects, 0);
    expect(patch.mode).toBe("propose");
    expect(patch.reason).toBe(
      "dome.markdown: archive 2 dead stub file(s) to attic/",
    );
    expect(patch.sourceRefs).toHaveLength(2);

    // Oldest-first: notes/empty.md (40d) before notes/Untitled 3.md (35d).
    expect(patch.changes).toEqual([
      expect.objectContaining({
        kind: "write",
        path: `${ATTIC_PREFIX}notes/empty.md`,
        content: "",
      }),
      expect.objectContaining({ kind: "delete", path: "notes/empty.md" }),
      expect.objectContaining({
        kind: "write",
        path: `${ATTIC_PREFIX}notes/Untitled 3.md`,
        content: "Untitled 3\n",
      }),
      expect.objectContaining({
        kind: "delete",
        path: "notes/Untitled 3.md",
      }),
    ]);
  });

  test("skips a fresh empty file (age below the minimum)", async () => {
    const effects = await runAtticSweep({
      files: {
        "notes/fresh-empty.md": {
          content: "   \n",
          lastChangedAt: daysBeforeNow(DEFAULT_ATTIC_MIN_AGE_DAYS - 1),
        },
      },
    });

    expect(effects).toHaveLength(0);
  });

  test("includes a file exactly at the minimum age (inclusive boundary)", async () => {
    const effects = await runAtticSweep({
      files: {
        "notes/boundary.md": {
          content: "",
          lastChangedAt: daysBeforeNow(DEFAULT_ATTIC_MIN_AGE_DAYS),
        },
      },
    });

    expect(effects).toHaveLength(1);
  });

  test("skips files already under attic/, inbox/, meta/, templates/, or the daily-notes dir", async () => {
    const effects = await runAtticSweep({
      files: {
        "attic/notes/old.md": { content: "", lastChangedAt: daysBeforeNow(90) },
        "inbox/raw/old.md": { content: "", lastChangedAt: daysBeforeNow(90) },
        "meta/old.md": { content: "", lastChangedAt: daysBeforeNow(90) },
        "templates/old.md": { content: "", lastChangedAt: daysBeforeNow(90) },
        "wiki/dailies/2026-01-01.md": {
          content: "",
          lastChangedAt: daysBeforeNow(90),
        },
      },
    });

    expect(effects).toHaveLength(0);
  });

  test("skips non-empty, non-Untitled pages", async () => {
    const effects = await runAtticSweep({
      files: {
        "wiki/entities/danny.md": {
          content: "# Danny\n\nSome real content.\n",
          lastChangedAt: daysBeforeNow(90),
        },
        "notes/Untitled-thing.md": {
          content: "not a matching stub name\n",
          lastChangedAt: daysBeforeNow(90),
        },
      },
    });

    expect(effects).toHaveLength(0);
  });

  test("caps at attic_max_files, oldest first", async () => {
    const files: Record<string, { readonly content: string; readonly lastChangedAt: string }> = {};
    for (let i = 0; i < DEFAULT_ATTIC_MAX_FILES + 5; i++) {
      files[`notes/Untitled ${i}.md`] = {
        content: "",
        // Larger i => older (further in the past), so ordering is deterministic.
        lastChangedAt: daysBeforeNow(40 + i),
      };
    }

    const effects = await runAtticSweep({ files });

    expect(effects).toHaveLength(1);
    const patch = expectPatch(effects, 0);
    // Each candidate contributes a write + delete pair.
    expect(patch.changes).toHaveLength(DEFAULT_ATTIC_MAX_FILES * 2);
    // The oldest (highest i, since lastChangedAt = now - (40+i) days) files win.
    const oldestPath = `notes/Untitled ${DEFAULT_ATTIC_MAX_FILES + 4}.md`;
    expect(patch.changes[0]).toEqual(
      expect.objectContaining({
        kind: "write",
        path: `${ATTIC_PREFIX}${oldestPath}`,
      }),
    );
  });

  test("zero candidates yields zero effects (idempotent)", async () => {
    const effects = await runAtticSweep({ files: {} });
    expect(effects).toHaveLength(0);
  });

  test("a file with no getFileInfo evidence is skipped conservatively", async () => {
    const effects = await runAtticSweep({
      files: {
        "notes/no-info.md": {
          content: "",
          lastChangedAt: daysBeforeNow(90),
          noFileInfo: true,
        },
      },
    });

    expect(effects).toHaveLength(0);
  });

  test("config overrides attic_min_age_days, attic_max_files, and attic_exclude_prefixes", async () => {
    const shortAge = await runAtticSweep({
      files: {
        "notes/recent.md": { content: "", lastChangedAt: daysBeforeNow(2) },
      },
      config: { attic_min_age_days: 1 },
    });
    expect(shortAge).toHaveLength(1);

    const capped = await runAtticSweep({
      files: {
        "notes/a.md": { content: "", lastChangedAt: daysBeforeNow(50) },
        "notes/b.md": { content: "", lastChangedAt: daysBeforeNow(51) },
      },
      config: { attic_max_files: 1 },
    });
    expect(expectPatch(capped, 0).changes).toHaveLength(2);

    const excluded = await runAtticSweep({
      files: {
        "scratch/old.md": { content: "", lastChangedAt: daysBeforeNow(90) },
      },
      config: { attic_exclude_prefixes: ["scratch/"] },
    });
    expect(excluded).toHaveLength(0);
  });

  test("degrades to defaults on malformed config rather than crashing", async () => {
    const effects = await runAtticSweep({
      files: {
        "notes/empty.md": { content: "", lastChangedAt: daysBeforeNow(40) },
      },
      config: {
        attic_min_age_days: "not-a-number",
        attic_max_files: -3,
        attic_exclude_prefixes: "not-an-array",
      },
    });

    expect(effects).toHaveLength(1);
  });
});

function daysBeforeNow(days: number): string {
  return new Date(
    new Date(NOW).getTime() - days * 24 * 60 * 60 * 1000,
  ).toISOString();
}

type FileFixture = {
  readonly content: string;
  readonly lastChangedAt: string;
  readonly noFileInfo?: boolean;
};

async function runAtticSweep(opts: {
  readonly files: Readonly<Record<string, FileFixture>>;
  readonly config?: ExtensionConfig;
}) {
  const ctx = makeProcessorContext({
    snapshot: fakeSnapshot(opts.files),
    changedPaths: [],
    proposal: null,
    runId: "run-attic-sweep",
    signal: new AbortController().signal,
    now: new Date(NOW),
    input: { kind: "schedule", cron: "45 4 * * 0", firedAt: NOW },
    ...(opts.config !== undefined ? { extensionConfig: opts.config } : {}),
  });

  return atticSweep.run(ctx);
}

function fakeSnapshot(files: Readonly<Record<string, FileFixture>>): Snapshot {
  return Object.freeze({
    commit: HEAD_COMMIT,
    tree: TREE,
    readFile: async (path: string) => files[path]?.content ?? null,
    listMarkdownFiles: async () =>
      Object.freeze(Object.keys(files).filter((path) => path.endsWith(".md"))),
    getFileInfo: async (path: string) => {
      const file = files[path];
      if (file === undefined || file.noFileInfo === true) return null;
      return {
        lastChangedCommit: HEAD_COMMIT,
        lastChangedAt: file.lastChangedAt,
        lastHumanChangedAt: file.lastChangedAt,
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
