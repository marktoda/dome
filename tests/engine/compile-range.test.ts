// Smoke tests for src/engine/compile-range.ts. Exercises tree-diff +
// signal-synthesis against a real fixture vault with two commits.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as git from "isomorphic-git";
import fs from "node:fs";
import { commit, currentSha, initRepo } from "../../src/git";
import { compileRange } from "../../src/engine/compile-range";
import { commitOid } from "../../src/core/source-ref";

type Fixture = {
  path: string;
  base: string;
  head: string;
  cleanup: () => Promise<void>;
};

/**
 * Build a fixture repo with a base commit (`baseFiles` staged + committed) and
 * a head commit (`mutate` runs in-place, then `headStage` + `headRemove` are
 * applied to the index). Returns both SHAs.
 */
async function makeFixture(opts: {
  readonly baseFiles: ReadonlyArray<[string, string]>;
  readonly mutate: (path: string) => Promise<void>;
  readonly headStage: ReadonlyArray<string>;
  readonly headRemove?: ReadonlyArray<string>;
}): Promise<Fixture> {
  const path = mkdtempSync(join(tmpdir(), "compile-range-"));
  await initRepo(path);
  // Create dirs lazily as needed by the writes below.
  for (const [rel, content] of opts.baseFiles) {
    await mkdir(join(path, rel, ".."), { recursive: true });
    await writeFile(join(path, rel), content);
  }
  const base = await commit({
    path,
    message: "base\n",
    files: opts.baseFiles.map(([rel]) => rel),
  });

  await opts.mutate(path);

  // Stage any new/modified files for the head commit.
  for (const rel of opts.headStage) {
    await git.add({ fs, dir: path, filepath: rel });
  }
  // Remove deleted files from the index.
  for (const rel of opts.headRemove ?? []) {
    await git.remove({ fs, dir: path, filepath: rel });
  }
  const head = await git.commit({
    fs,
    dir: path,
    message: "head\n",
    author: { name: "Dome", email: "dome@local" },
  });

  return {
    path,
    base,
    head,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

const fixtures: Fixture[] = [];
afterEach(async () => {
  while (fixtures.length > 0) {
    const f = fixtures.pop();
    if (f !== undefined) await f.cleanup();
  }
});

describe("compileRange", () => {
  test("same base + head SHA → empty changedPaths and signals", async () => {
    const f = await makeFixture({
      baseFiles: [["wiki/seed.md", "seed\n"]],
      mutate: async () => undefined,
      headStage: [],
    });
    fixtures.push(f);
    const sha = await currentSha(f.path);
    if (sha === null) throw new Error("expected sha");
    const r = await compileRange({
      vaultPath: f.path,
      base: commitOid(sha),
      head: commitOid(sha),
    });
    expect(r.changedPaths).toEqual([]);
    expect(r.signals).toEqual([]);
  });

  test("single added markdown file → 1 added path, 2 signals", async () => {
    const f = await makeFixture({
      baseFiles: [["wiki/seed.md", "seed\n"]],
      mutate: async (path) => {
        await writeFile(join(path, "wiki/new.md"), "new\n");
      },
      headStage: ["wiki/new.md"],
    });
    fixtures.push(f);
    const r = await compileRange({
      vaultPath: f.path,
      base: commitOid(f.base),
      head: commitOid(f.head),
    });
    expect(r.addedPaths).toEqual(["wiki/new.md"]);
    expect(r.signals.length).toBe(2);
    expect(r.signals[0]?.signal).toBe("file.created");
    expect(r.signals[1]?.signal).toBe("document.changed");
  });

  test("single modified non-markdown file → 1 modified path, 1 signal", async () => {
    const f = await makeFixture({
      baseFiles: [
        ["wiki/seed.md", "seed\n"],
        ["notes/seed.dat", "v1\n"],
      ],
      mutate: async (path) => {
        await writeFile(join(path, "notes/seed.dat"), "v2\n");
      },
      headStage: ["notes/seed.dat"],
    });
    fixtures.push(f);
    const r = await compileRange({
      vaultPath: f.path,
      base: commitOid(f.base),
      head: commitOid(f.head),
    });
    expect(r.modifiedPaths).toEqual(["notes/seed.dat"]);
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]?.signal).toBe("file.modified");
  });

  test("single deleted file → 1 deleted path, 1 signal", async () => {
    const f = await makeFixture({
      baseFiles: [
        ["wiki/seed.md", "seed\n"],
        ["notes/bin.dat", "v\n"],
      ],
      mutate: async (path) => {
        await unlink(join(path, "notes/bin.dat"));
      },
      headStage: [],
      headRemove: ["notes/bin.dat"],
    });
    fixtures.push(f);
    const r = await compileRange({
      vaultPath: f.path,
      base: commitOid(f.base),
      head: commitOid(f.head),
    });
    expect(r.deletedPaths).toEqual(["notes/bin.dat"]);
    expect(r.signals.length).toBe(1);
    expect(r.signals[0]?.signal).toBe("file.deleted");
  });

  test("deterministic — same (base, head) produces identical signals on repeated calls", async () => {
    const f = await makeFixture({
      baseFiles: [["wiki/seed.md", "seed\n"]],
      mutate: async (path) => {
        await writeFile(join(path, "wiki/new.md"), "new\n");
      },
      headStage: ["wiki/new.md"],
    });
    fixtures.push(f);
    const r1 = await compileRange({
      vaultPath: f.path,
      base: commitOid(f.base),
      head: commitOid(f.head),
    });
    const r2 = await compileRange({
      vaultPath: f.path,
      base: commitOid(f.base),
      head: commitOid(f.head),
    });
    expect(r2.signals).toEqual(r1.signals);
  });
});
