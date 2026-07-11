import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { commitOid } from "../../src/core/source-ref";
import { commit, initRepo } from "../../src/git";
import { createRevisionSource } from "../../src/revisions/revision-source";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

describe("RevisionSource", () => {
  test("shares immutable manifests and blob text across revision and diff callers", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-revision-source-"));
    roots.push(root);
    await initRepo(root);
    await mkdir(join(root, "wiki"), { recursive: true });
    await writeFile(join(root, "wiki/a.md"), "alpha\n");
    const base = commitOid(await commit({
      path: root,
      message: "base\n",
      files: ["wiki/a.md"],
    }));
    await writeFile(join(root, "wiki/b.md"), "beta\n");
    const head = commitOid(await commit({
      path: root,
      message: "head\n",
      files: ["wiki/b.md"],
    }));

    const source = createRevisionSource(root);
    const revision = await source.revision(head);
    expect(await revision.paths()).toEqual(["wiki/a.md", "wiki/b.md"]);
    expect(await revision.snapshot.listMarkdownFiles()).toEqual([
      "wiki/a.md",
      "wiki/b.md",
    ]);
    expect(await revision.snapshot.readFile("wiki/a.md")).toBe("alpha\n");
    expect(await revision.snapshot.readFile("wiki/a.md")).toBe("alpha\n");

    const first = await source.diff(base, head);
    const second = await source.diff(base, head);
    expect(first).toEqual(second);
    expect(first.addedPaths).toEqual(["wiki/b.md"]);

    const metrics = source.metrics();
    expect(metrics.manifestLoads).toBe(2);
    expect(metrics.blobLoads).toBe(1);
    expect(metrics.blobHits).toBe(1);
  });

  test("keeps tree and manifest I/O lazy when processors never read snapshot content", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-revision-source-lazy-"));
    roots.push(root);
    await initRepo(root);
    await writeFile(join(root, "seed.md"), "seed\n");
    const head = commitOid(await commit({
      path: root,
      message: "seed\n",
      files: ["seed.md"],
    }));

    const source = createRevisionSource(root);
    await source.revision(head);
    expect(source.metrics().treeLoads).toBe(1);
    expect(source.metrics().manifestLoads).toBe(0);
    expect(source.metrics().blobLoads).toBe(0);
  });
});
