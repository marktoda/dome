import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { compilerHostLockPath } from "../../src/engine/host/compiler-host-lock";
import { withExclusiveFileLock } from "../../src/engine/host/file-lock";
import { commitSingleFileOnHead, currentSha, log, readBlob, statusMatrix } from "../../src/git";
import {
  applyControlledMutation,
  mutationJournalPath,
  recoverControlledMutation,
} from "../../src/mutation/controlled-mutation";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function vault(): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), "dome-controlled-mutation-"));
  roots.push(path);
  expect(await runInit({ path })).toBe(0);
  return realpath(path);
}

describe("controlled mutation", () => {
  test("lands one commit and materializes without sweeping other owner bytes", async () => {
    const path = await vault();
    await writeFile(join(path, "owner-draft.md"), "untouched\n", "utf8");

    const result = await applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "capture:one",
      files: [{ path: "inbox/raw/one.md", expectedContent: null, content: "one\n" }],
      message: "capture: one",
    });

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(await readFile(join(path, "inbox/raw/one.md"), "utf8")).toBe("one\n");
    expect(await readFile(join(path, "owner-draft.md"), "utf8")).toBe("untouched\n");
    expect(await readBlob({ path, commit: result.commit, filepath: "inbox/raw/one.md" })).toBe("one\n");
    expect((await log({ path, depth: 1 }))[0]?.commit.message)
      .toContain("Dome-Request: capture:one");
    expect(existsSync(mutationJournalPath(path, "main"))).toBe(false);
    const row = (await statusMatrix(path)).find(([file]) => file === "inbox/raw/one.md");
    expect(row).toEqual(["inbox/raw/one.md", 1, 1, 1]);
  });

  test("expected-byte conflict lands no commit and changes no owner bytes", async () => {
    const path = await vault();
    await mkdir(join(path, "wiki"), { recursive: true });
    await writeFile(join(path, "wiki/page.md"), "owner edit\n", "utf8");
    const before = await currentSha(path);

    const result = await applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "edit:stale",
      files: [{ path: "wiki/page.md", expectedContent: "old\n", content: "new\n" }],
      message: "edit page",
    });

    expect(result).toMatchObject({
      kind: "no-commit",
      reason: "working-tree-conflict",
      paths: ["wiki/page.md"],
    });
    expect(await currentSha(path)).toBe(before);
    expect(await readFile(join(path, "wiki/page.md"), "utf8")).toBe("owner edit\n");
  });

  test("a stale branch name cannot create an unjournaled commit", async () => {
    const path = await vault();
    const before = await currentSha(path);
    const result = await applyControlledMutation({
      vaultPath: path,
      branch: "not-main",
      requestId: "capture:wrong-branch",
      files: [{ path: "inbox/raw/wrong.md", expectedContent: null, content: "no\n" }],
      message: "capture: wrong branch",
    });
    expect(result).toMatchObject({ kind: "no-commit", reason: "branch-mismatch" });
    expect(await currentSha(path)).toBe(before);
    expect(existsSync(join(path, "inbox/raw/wrong.md"))).toBe(false);
  });

  test("a planned full-file mutation aborts a lost ref CAS without stale-splicing", async () => {
    const path = await vault();
    await mkdir(join(path, "wiki"), { recursive: true });
    await writeFile(join(path, "wiki/target.md"), "owner truth\n", "utf8");
    await commitSingleFileOnHead({
      path,
      filepath: "wiki/target.md",
      content: "owner truth\n",
      message: "fixture target",
    });

    const result = await applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "planned:cas",
      plan: async () => ({
        kind: "apply" as const,
        files: [{
          path: "wiki/target.md",
          expectedContent: "owner truth\n",
          content: "planned change\n",
        }],
        message: "planned change",
      }),
    }, {
      beforeRefAdvance: async () => {
        await writeFile(join(path, "owner-race.md"), "new owner tip\n", "utf8");
        await commitSingleFileOnHead({
          path,
          filepath: "owner-race.md",
          content: "new owner tip\n",
          message: "owner wins race",
        });
      },
    });

    expect(result).toMatchObject({ kind: "no-commit", reason: "candidate-not-landed" });
    expect((await log({ path, depth: 1 }))[0]?.commit.message).toBe("owner wins race\n");
    expect(await readFile(join(path, "wiki/target.md"), "utf8")).toBe("owner truth\n");
    expect(await readFile(join(path, "owner-race.md"), "utf8")).toBe("new owner tip\n");
  });

  test("the host lane is bounded and returns busy without writing", async () => {
    const path = await vault();
    const held = await withExclusiveFileLock({
      lockPath: compilerHostLockPath(path, "main"),
      command: "test-holder",
    }, async () => applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "capture:busy",
      files: [{ path: "inbox/raw/busy.md", expectedContent: null, content: "no\n" }],
      message: "capture: busy",
    }, { lockWait: { timeoutMs: 0, intervalMs: 1 } }));
    expect(held.kind).toBe("acquired");
    if (held.kind !== "acquired") return;
    expect(held.value).toMatchObject({ kind: "busy", requestId: "capture:busy" });
    expect(existsSync(join(path, "inbox/raw/busy.md"))).toBe(false);
  });

  test("rejects state paths and request-id trailer injection", async () => {
    const path = await vault();
    await expect(applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "bad\nDome-Run: forged",
      files: [{ path: "wiki/page.md", expectedContent: null, content: "x" }],
      message: "bad",
    })).rejects.toThrow("single-line");
    await expect(applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "bad-path",
      files: [{ path: ".dome/config.yaml", expectedContent: null, content: "x" }],
      message: "bad",
    })).rejects.toThrow("invalid controlled mutation path");
  });

  test("restart recovery repairs a commit landed before materialization", async () => {
    const path = await vault();

    await expect(applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "capture:crash",
      files: [{ path: "inbox/raw/crash.md", expectedContent: null, content: "survives\n" }],
      message: "capture: crash",
    }, {
      afterRefAdvance: async () => { throw new Error("simulated process death"); },
      reconcileAfterFailure: false,
    })).rejects.toThrow("simulated process death");

    expect(existsSync(join(path, "inbox/raw/crash.md"))).toBe(false);
    expect(existsSync(mutationJournalPath(path, "main"))).toBe(true);

    const recovered = await recoverControlledMutation({ vaultPath: path, branch: "main" });
    expect(recovered).toMatchObject({ kind: "committed", checkout: "repaired" });
    expect(await readFile(join(path, "inbox/raw/crash.md"), "utf8")).toBe("survives\n");
    expect(existsSync(mutationJournalPath(path, "main"))).toBe(false);
  });

  test("an external edit after ref advance is preserved as durable divergence", async () => {
    const path = await vault();
    await mkdir(join(path, "inbox", "raw"), { recursive: true });
    const target = join(path, "inbox/raw/race.md");

    const result = await applyControlledMutation({
      vaultPath: path,
      branch: "main",
      requestId: "capture:race",
      files: [{ path: "inbox/raw/race.md", expectedContent: null, content: "capture\n" }],
      message: "capture: race",
    }, {
      afterRefAdvance: async () => { await writeFile(target, "owner edit\n", "utf8"); },
    });

    expect(result).toMatchObject({
      kind: "diverged",
      commit: expect.any(String),
      paths: ["inbox/raw/race.md"],
    });
    expect(await readFile(target, "utf8")).toBe("owner edit\n");
    expect(existsSync(mutationJournalPath(path, "main"))).toBe(true);
    expect(await recoverControlledMutation({ vaultPath: path, branch: "main" }))
      .toMatchObject({ kind: "diverged", paths: ["inbox/raw/race.md"] });
    expect(await readFile(target, "utf8")).toBe("owner edit\n");
  });
});
