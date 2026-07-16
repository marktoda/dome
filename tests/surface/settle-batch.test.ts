import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { setAdoptedRef } from "../../src/adopted-ref";
import { runInit } from "../../src/cli/commands/init";
import { add, commitSingleFileOnHead, currentBranch, currentSha, log } from "../../src/git";
import {
  performSettleBatch,
  SETTLE_BATCH_SCHEMA,
  type SettleBatchRequest,
} from "../../src/surface/settle";

let dirs: string[] = [];
const originalLog = console.log;
const originalError = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

async function vault(): Promise<string> {
  const path = mkdtempSync(join(tmpdir(), "dome-settle-batch-"));
  dirs.push(path);
  expect(await runInit({ path })).toBe(0);
  return path;
}

async function commitFile(path: string, filepath: string, content: string): Promise<void> {
  await mkdir(dirname(join(path, filepath)), { recursive: true });
  await writeFile(join(path, filepath), content);
  await commitSingleFileOnHead({
    path,
    filepath,
    content,
    message: `fixture: ${filepath}`,
    author: { name: "fixture", email: "fixture@local" },
  });
}

async function adoptHead(path: string): Promise<string> {
  const branch = await currentBranch(path);
  const head = await currentSha(path);
  if (branch === null || head === null) throw new Error("fixture has no branch/head");
  const result = await setAdoptedRef(path, branch, head);
  if (!result.ok) throw new Error(result.error.message);
  return head;
}

function decision(
  revision: string,
  path: string,
  line: number,
  blockId: string,
  disposition: "keep" | "close",
): SettleBatchRequest["decisions"][number] {
  return {
    blockId,
    disposition,
    sourceRef: {
      path,
      commit: revision,
      stableId: `dome.daily.open-loop:${blockId}`,
      range: { startLine: line, endLine: line },
    },
  };
}

const now = () => new Date(2026, 6, 16, 9, 0, 0);

describe("performSettleBatch", () => {
  test("merges mixed same/cross-file decisions into one commit and replays as a no-op", async () => {
    const path = await vault();
    await commitFile(path, "wiki/a.md", [
      "# A", "", "- [ ] #task close A ^ta111", "- [ ] #task defer A ^ta222", "",
    ].join("\n"));
    await commitFile(path, "wiki/b.md", [
      "# B", "", "- [ ] #task close B ^tb111", "",
    ].join("\n"));
    const revision = await adoptHead(path);
    const request: SettleBatchRequest = {
      schema: SETTLE_BATCH_SCHEMA,
      revision,
      decisions: [
        decision(revision, "wiki/a.md", 3, "ta111", "close"),
        {
          blockId: "ta222",
          disposition: "defer",
          deferUntil: "2026-08-01",
          sourceRef: {
            path: "wiki/a.md", commit: revision,
            stableId: "dome.daily.open-loop:ta222",
            range: { startLine: 4, endLine: 4 },
          },
        },
        decision(revision, "wiki/b.md", 3, "tb111", "close"),
      ],
    };
    const before = await currentSha(path);
    const result = await performSettleBatch(path, request, { now });
    expect(result).toMatchObject({
      status: "settled",
      reviewed: { keep: 0, close: 2, defer: 1 },
      adoptionStatus: "pending",
    });
    expect(result.status === "settled" ? result.commit : null).not.toBeNull();
    expect(await currentSha(path)).not.toBe(before);
    expect((await log({ path, depth: 2 }))[0]?.commit.message)
      .toContain("task backlog review: 3 decisions");
    expect(await readFile(join(path, "wiki/a.md"), "utf8"))
      .toContain("- [x] #task close A ^ta111");
    expect(await readFile(join(path, "wiki/a.md"), "utf8"))
      .toContain("- [ ] #task defer A 📅 2026-08-01 ^ta222");
    const daily = await readFile(join(path, "wiki/dailies/2026-07-16.md"), "utf8");
    expect(daily.match(/### Done today/g)).toHaveLength(1);
    expect(daily).toContain("#^ta111|from]])");
    expect(daily).toContain("#^tb111|from]])");

    const landed = await currentSha(path);
    const replay = await performSettleBatch(path, request, { now });
    expect(replay).toMatchObject({ status: "settled", commit: null, adoptionStatus: "unchanged" });
    expect(await currentSha(path)).toBe(landed);
  });

  test("validates keep decisions but lands no commit", async () => {
    const path = await vault();
    await commitFile(path, "wiki/a.md", "# A\n\n- [ ] #task keep A ^tkeep\n");
    const revision = await adoptHead(path);
    const before = await currentSha(path);
    const result = await performSettleBatch(path, {
      schema: SETTLE_BATCH_SCHEMA,
      revision,
      decisions: [decision(revision, "wiki/a.md", 3, "tkeep", "keep")],
    });
    expect(result).toMatchObject({ status: "settled", commit: null });
    expect(await currentSha(path)).toBe(before);
  });

  test("rejects stale reviews and duplicate dispositions before committing", async () => {
    const path = await vault();
    await commitFile(path, "wiki/a.md", "# A\n\n- [ ] #task A ^tstale\n");
    const revision = await adoptHead(path);
    const one = decision(revision, "wiki/a.md", 3, "tstale", "keep");
    const duplicate = await performSettleBatch(path, {
      schema: SETTLE_BATCH_SCHEMA,
      revision,
      decisions: [one, one],
    });
    expect(duplicate).toMatchObject({ status: "error", error: "invalid-request" });

    await commitFile(path, "wiki/unrelated.md", "# newer adopted truth\n");
    await adoptHead(path);
    const before = await currentSha(path);
    const stale = await performSettleBatch(path, {
      schema: SETTLE_BATCH_SCHEMA,
      revision,
      decisions: [one],
    });
    expect(stale).toMatchObject({ status: "error", error: "stale-review" });
    expect(await currentSha(path)).toBe(before);
  });

  test("allows unrelated drift but rejects target index dirtiness", async () => {
    const path = await vault();
    const original = "# A\n\n- [ ] #task keep A ^tdirty\n";
    await commitFile(path, "wiki/a.md", original);
    const revision = await adoptHead(path);
    const request = {
      schema: SETTLE_BATCH_SCHEMA,
      revision,
      decisions: [decision(revision, "wiki/a.md", 3, "tdirty", "keep")],
    } as const;

    // A newer, unrelated descendant HEAD is safe because exact source bytes
    // are revalidated under the mutation lock.
    await commitFile(path, "wiki/unrelated.md", "# unrelated newer truth\n");
    await writeFile(join(path, "owner-draft.md"), "unrelated untracked draft\n");
    expect(await performSettleBatch(path, request)).toMatchObject({
      status: "settled",
      commit: null,
    });

    // Even with working bytes restored to HEAD, staged target bytes are an
    // owner conflict and must reject the whole batch.
    await writeFile(join(path, "wiki/a.md"), original.replace("# A", "# staged owner edit"));
    await add(path, "wiki/a.md");
    await writeFile(join(path, "wiki/a.md"), original);
    const before = await currentSha(path);
    expect(await performSettleBatch(path, request)).toMatchObject({
      status: "error",
      error: "conflict",
    });
    expect(await currentSha(path)).toBe(before);
    expect(await readFile(join(path, "owner-draft.md"), "utf8"))
      .toBe("unrelated untracked draft\n");
  });
});
