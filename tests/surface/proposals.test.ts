// surface/proposals — tests for `collectProposals` / `performApply` /
// `performReject`, the human-side decision surface for garden propose-mode
// patches (docs/superpowers/plans/2026-07-06-product-review-4-tier1.md
// §"Task 5"). Mirrors `tests/surface/settle.test.ts`'s fixture shape: a real
// temp git vault, real commits, no mocks.
//
// Pinned behaviors:
//   - collectProposals lists pending rows with a `stale` flag and a
//     line-count `diffStat`.
//   - performApply writes every change, lands ONE commit
//     (`apply(P<id>): <reason>`), and CAS-decides the row to `applied`.
//   - A second apply on the same id is `not-pending`.
//   - A working-tree mutation since enqueue makes apply `stale` and leaves
//     the file (and the row) untouched.
//   - A delete-change proposal applies: the file is removed from the working
//     tree and from HEAD via `commitFilesOnHead`'s `content: null` entries.
//   - An already-satisfied delete (file already absent) is skipped as
//     idempotent, not stale; a proposal that is all-satisfied-deletes with no
//     writes lands no commit.
//   - An already-satisfied write is likewise skipped, so retry after commit
//     but before proposal CAS converges without another commit.
//   - performReject CAS-decides the row to `rejected` and lands no commit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fileChange, type FileChange } from "../../src/core/effect";
import { commitOid, sourceRef, type SourceRef } from "../../src/core/source-ref";
import { runInit } from "../../src/cli/commands/init";
import { compilerHostLockPath } from "../../src/engine/host/compiler-host-lock";
import { withExclusiveFileLock } from "../../src/engine/host/file-lock";
import { commitSingleFileOnHead, log, resolveRef } from "../../src/git";
import { openProposalsDb } from "../../src/proposals/db";
import { enqueuePendingProposal, getProposal } from "../../src/proposals/pending-proposals";
import {
  applyResultJson,
  collectProposals,
  performApply,
  performReject,
  proposalsJson,
} from "../../src/surface/proposals";

// ----- Fixtures -------------------------------------------------------------

let tempDirs: string[] = [];

const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  console.log = () => {};
  console.error = () => {};
});

afterEach(async () => {
  console.log = origLog;
  console.error = origErr;
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function initVault(): Promise<string> {
  const vault = tempDir("dome-proposals-vault-");
  expect(await runInit({ path: vault })).toBe(0);
  return vault;
}

/** Write `content` to disk AND land it in HEAD as a human commit. */
async function commitFile(vault: string, relPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(vault, relPath)), { recursive: true });
  await writeFile(join(vault, relPath), content, "utf8");
  await commitSingleFileOnHead({
    path: vault,
    filepath: relPath,
    content,
    message: `fixture: ${relPath}`,
    author: { name: "fixture", email: "fixture@local" },
  });
}

/** Write `content` to the working tree WITHOUT committing — simulates drift. */
async function mutateWorkingFile(vault: string, relPath: string, content: string): Promise<void> {
  await mkdir(dirname(join(vault, relPath)), { recursive: true });
  await writeFile(join(vault, relPath), content, "utf8");
}

async function headSha(vault: string): Promise<string> {
  return resolveRef({ path: vault, ref: "HEAD" });
}

const A_COMMIT = commitOid("a".repeat(40));
const DEFAULT_SOURCE_REFS: ReadonlyArray<SourceRef> = [
  sourceRef({ commit: A_COMMIT, path: "wiki/note.md" }),
];

/** Enqueue a proposal directly through the Task 1 store API — the fixture
 * scaffold this file's tests build proposals through, since the engine sink
 * (Task 3) is out of scope here. */
async function enqueueProposal(
  vault: string,
  overrides: {
    readonly processorId?: string;
    readonly reason?: string;
    readonly changes: ReadonlyArray<FileChange>;
    readonly baseContents: Readonly<Record<string, string | null>>;
    readonly createdAt?: string;
  },
): Promise<number> {
  const dbPath = join(vault, ".dome", "state", "proposals.db");
  const opened = await openProposalsDb({ path: dbPath });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("open failed");
  try {
    const result = enqueuePendingProposal(opened.value.db, {
      processorId: overrides.processorId ?? "dome.test.garden",
      extensionId: "test",
      runId: "run_1",
      reason: overrides.reason ?? "tidy up the note",
      changes: overrides.changes,
      sourceRefs: DEFAULT_SOURCE_REFS,
      baseCommit: "b".repeat(40),
      baseContents: overrides.baseContents,
      createdAt: overrides.createdAt ?? "2026-07-06T00:00:00.000Z",
    });
    expect(result.inserted).toBe(true);
    if (result.id === null) throw new Error("expected id");
    return result.id;
  } finally {
    opened.value.db.close();
  }
}

async function proposalStatus(vault: string, id: number): Promise<string | null> {
  const dbPath = join(vault, ".dome", "state", "proposals.db");
  const opened = await openProposalsDb({ path: dbPath });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("open failed");
  try {
    return getProposal(opened.value.db, id)?.status ?? null;
  } finally {
    opened.value.db.close();
  }
}

// ----- collectProposals -------------------------------------------------------

describe("collectProposals", () => {
  test("lists a pending row not-stale with a diffStat, computed from the real working file", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\nline2\n");

    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\nline3\n" })],
      baseContents: { "wiki/note.md": "line1\nline2\n" },
    });

    const result = await collectProposals(vault);
    expect(result.schema).toBe("dome.proposals/v1");
    expect(result.proposals).toHaveLength(1);
    const view = result.proposals[0]!;
    expect(view.id).toBe(id);
    expect(view.status).toBe("pending");
    expect(view.stale).toBe(false);
    expect(view.paths).toEqual(["wiki/note.md"]);
    expect(view.diffStat).toEqual([{ path: "wiki/note.md", added: 1, removed: 0 }]);

    const json = proposalsJson(result);
    expect(json["schema"]).toBe("dome.proposals/v1");
  });

  test("marks a row stale when the working file has drifted from baseContents", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\nline2\n");
    await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\nline3\n" })],
      baseContents: { "wiki/note.md": "line1\nline2\n" },
    });

    await mutateWorkingFile(vault, "wiki/note.md", "someone edited this already\n");

    const result = await collectProposals(vault);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]!.stale).toBe(true);
  });

  test("defaults to pending-only; --all lists every status", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "hello\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "hello again\n" })],
      baseContents: { "wiki/note.md": "hello\n" },
    });

    const rejected = await performReject(vault, id);
    expect(rejected.status).toBe("rejected");

    const pendingOnly = await collectProposals(vault);
    expect(pendingOnly.proposals).toHaveLength(0);

    const all = await collectProposals(vault, { all: true });
    expect(all.proposals).toHaveLength(1);
    expect(all.proposals[0]!.status).toBe("rejected");
  });
});

// ----- performApply -----------------------------------------------------------

describe("performApply", () => {
  test("writes the file, lands one commit, and marks the row applied", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\nline2\n");
    const id = await enqueueProposal(vault, {
      reason: "append a follow-up line to the note",
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\nline3\n" })],
      baseContents: { "wiki/note.md": "line1\nline2\n" },
    });
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.id).toBe(id);
    expect(typeof result.commit).toBe("string");
    expect(result.commit).not.toBe(before);

    // Exactly one new commit, message prefixed `apply(P<id>)`.
    const commits = await log({ path: vault, depth: 2 });
    expect(commits[0]!.oid).toBe(result.commit ?? "");
    expect(commits[0]!.commit.parent[0]!).toBe(before);
    expect(commits[0]!.commit.message.startsWith(`apply(P${id}):`)).toBe(true);
    expect(commits[0]!.commit.message).toContain(
      `Dome-Request: apply:proposal:${id}`,
    );

    // Working file carries the proposed content.
    const written = await Bun.file(join(vault, "wiki/note.md")).text();
    expect(written).toBe("line1\nline2\nline3\n");

    // Row is durably applied.
    expect(await proposalStatus(vault, id)).toBe("applied");

    const json = applyResultJson(result);
    expect(json["status"]).toBe("applied");
    expect(json["commit"]).toBe(result.commit);
  });

  test("a second apply on the same id is not-pending", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    const first = await performApply(vault, id);
    expect(first.status).toBe("applied");

    const second = await performApply(vault, id);
    expect(second.status).toBe("not-pending");
  });

  test("a landed commit remains applied when owner bytes force checkout recovery", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "base\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "proposed\n" })],
      baseContents: { "wiki/note.md": "base\n" },
    });
    const result = await performApply(vault, id, {
      afterRefAdvance: async () => {
        await writeFile(join(vault, "wiki/note.md"), "owner edit\n", "utf8");
      },
    });

    expect(result).toMatchObject({
      status: "applied",
      commit: expect.any(String),
      recoveryRequired: true,
    });
    expect(await proposalStatus(vault, id)).toBe("applied");
    expect(await Bun.file(join(vault, "wiki/note.md")).text()).toBe("owner edit\n");
    expect(applyResultJson(result)["recovery_required"]).toBe(true);
  });

  test("a working-tree mutation since enqueue makes apply stale and leaves the file untouched", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    await mutateWorkingFile(vault, "wiki/note.md", "someone edited this already\n");
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("stale");
    if (result.status !== "stale") throw new Error("unreachable");
    expect(result.id).toBe(id);
    expect(result.changedPaths).toEqual(["wiki/note.md"]);

    // No commit landed and the drifted content is untouched (not overwritten
    // with the proposed content, not reverted to baseContents).
    expect(await headSha(vault)).toBe(before);
    const onDisk = await Bun.file(join(vault, "wiki/note.md")).text();
    expect(onDisk).toBe("someone edited this already\n");

    // The row is still pending — nothing was decided.
    expect(await proposalStatus(vault, id)).toBe("pending");
  });

  test("expected-byte CAS catches drift after classification while waiting for the host lane", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({
        kind: "write",
        path: "wiki/note.md",
        content: "line1\nline2\n",
      })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    const before = await headSha(vault);
    let release!: () => void;
    let acquired!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const lockAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = withExclusiveFileLock({
      lockPath: compilerHostLockPath(vault, "main"),
      command: "apply-cas-test-holder",
    }, async () => {
      acquired();
      await released;
    });
    await lockAcquired;

    const applying = performApply(vault, id);
    await Bun.sleep(75);
    await mutateWorkingFile(vault, "wiki/note.md", "owner edit during admission\n");
    release();
    await holder;

    const result = await applying;
    expect(result).toMatchObject({
      status: "stale",
      id,
      changedPaths: ["wiki/note.md"],
    });
    expect(await headSha(vault)).toBe(before);
    expect(await Bun.file(join(vault, "wiki/note.md")).text()).toBe(
      "owner edit during admission\n",
    );
    expect(await proposalStatus(vault, id)).toBe("pending");
  });

  test("a new-file proposal (baseContents null, file still absent) is not stale and applies cleanly", async () => {
    const vault = await initVault();
    const id = await enqueueProposal(vault, {
      reason: "create a fresh page",
      changes: [
        fileChange({ kind: "write", path: "wiki/new-page.md", content: "brand new content\n" }),
      ],
      baseContents: { "wiki/new-page.md": null },
    });

    // Not stale: null base + still-absent working file agree.
    const listed = await collectProposals(vault);
    expect(listed.proposals[0]!.stale).toBe(false);

    const before = await headSha(vault);
    const result = await performApply(vault, id);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.commit).not.toBe(before);

    // The file was created with the proposed content and the row is applied.
    const written = await Bun.file(join(vault, "wiki/new-page.md")).text();
    expect(written).toBe("brand new content\n");
    expect(await proposalStatus(vault, id)).toBe("applied");
  });

  test("a new-file proposal is stale when the file has been created since enqueue", async () => {
    const vault = await initVault();
    const id = await enqueueProposal(vault, {
      reason: "create a fresh page",
      changes: [
        fileChange({ kind: "write", path: "wiki/new-page.md", content: "brand new content\n" }),
      ],
      baseContents: { "wiki/new-page.md": null },
    });

    // The owner (or another process) creates the file after enqueue.
    await mutateWorkingFile(vault, "wiki/new-page.md", "owner wrote this first\n");
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("stale");
    if (result.status !== "stale") throw new Error("unreachable");
    expect(result.changedPaths).toEqual(["wiki/new-page.md"]);

    // No commit, the owner's content is untouched, and the row stays pending.
    expect(await headSha(vault)).toBe(before);
    const onDisk = await Bun.file(join(vault, "wiki/new-page.md")).text();
    expect(onDisk).toBe("owner wrote this first\n");
    expect(await proposalStatus(vault, id)).toBe("pending");
  });

  test("an all-satisfied write retry marks the row applied without a second commit", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "base\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({
        kind: "write",
        path: "wiki/note.md",
        content: "proposed\n",
      })],
      baseContents: { "wiki/note.md": "base\n" },
    });

    // State after the controlled commit landed but before pending -> applied.
    await commitFile(vault, "wiki/note.md", "proposed\n");
    const landed = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result).toEqual({ status: "applied", id });
    expect(await headSha(vault)).toBe(landed);
    expect(await proposalStatus(vault, id)).toBe("applied");
  });

  test("a mixed satisfied and eligible retry commits only the remaining change", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/one.md", "one base\n");
    await commitFile(vault, "wiki/two.md", "two base\n");
    const id = await enqueueProposal(vault, {
      changes: [
        fileChange({ kind: "write", path: "wiki/one.md", content: "one proposed\n" }),
        fileChange({ kind: "write", path: "wiki/two.md", content: "two proposed\n" }),
      ],
      baseContents: {
        "wiki/one.md": "one base\n",
        "wiki/two.md": "two base\n",
      },
    });
    await commitFile(vault, "wiki/one.md", "one proposed\n");
    const beforeApply = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.commit).not.toBe(beforeApply);
    const commits = await log({ path: vault, depth: 2 });
    expect(commits[0]!.commit.parent[0]).toBe(beforeApply);
    expect(await Bun.file(join(vault, "wiki/one.md")).text()).toBe("one proposed\n");
    expect(await Bun.file(join(vault, "wiki/two.md")).text()).toBe("two proposed\n");
    expect(await proposalStatus(vault, id)).toBe("applied");
  });

  test("a delete-change proposal applies: file removed, one commit, row applied", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/stale-page.md", "old content\n");
    const id = await enqueueProposal(vault, {
      reason: "archive the dead stub",
      changes: [fileChange({ kind: "delete", path: "wiki/stale-page.md" })],
      baseContents: { "wiki/stale-page.md": "old content\n" },
    });
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.commit).not.toBe(before);

    const commits = await log({ path: vault, depth: 2 });
    expect(commits[0]!.oid).toBe(result.commit ?? "");
    expect(commits[0]!.commit.message.startsWith(`apply(P${id}):`)).toBe(true);

    expect(existsSync(join(vault, "wiki/stale-page.md"))).toBe(false);
    expect(await proposalStatus(vault, id)).toBe("applied");
  });

  test("a mixed write+delete proposal lands one commit with both effects", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    await commitFile(vault, "wiki/old.md", "retired content\n");
    const id = await enqueueProposal(vault, {
      reason: "consolidate the note and archive the old page",
      changes: [
        fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" }),
        fileChange({ kind: "delete", path: "wiki/old.md" }),
      ],
      baseContents: { "wiki/note.md": "line1\n", "wiki/old.md": "retired content\n" },
    });
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.commit).not.toBe(before);

    // Exactly one new commit.
    const commits = await log({ path: vault, depth: 2 });
    expect(commits[0]!.oid).toBe(result.commit ?? "");
    expect(commits[0]!.commit.parent[0]!).toBe(before);

    const written = await Bun.file(join(vault, "wiki/note.md")).text();
    expect(written).toBe("line1\nline2\n");
    expect(existsSync(join(vault, "wiki/old.md"))).toBe(false);
    expect(await proposalStatus(vault, id)).toBe("applied");
  });

  test("a delete-change is stale when the file was edited (not deleted) since enqueue", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/stale-page.md", "old content\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "delete", path: "wiki/stale-page.md" })],
      baseContents: { "wiki/stale-page.md": "old content\n" },
    });

    await mutateWorkingFile(vault, "wiki/stale-page.md", "someone edited this already\n");
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("stale");
    if (result.status !== "stale") throw new Error("unreachable");
    expect(result.changedPaths).toEqual(["wiki/stale-page.md"]);

    expect(await headSha(vault)).toBe(before);
    const onDisk = await Bun.file(join(vault, "wiki/stale-page.md")).text();
    expect(onDisk).toBe("someone edited this already\n");
    expect(await proposalStatus(vault, id)).toBe("pending");
  });

  test("an already-absent delete is skipped as satisfied — not stale", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/stale-page.md", "old content\n");
    await enqueueProposal(vault, {
      changes: [fileChange({ kind: "delete", path: "wiki/stale-page.md" })],
      baseContents: { "wiki/stale-page.md": "old content\n" },
    });

    // Someone (or another apply) already removed the file from the working
    // tree without going through this proposal.
    await unlink(join(vault, "wiki/stale-page.md"));

    const listed = await collectProposals(vault);
    expect(listed.proposals[0]!.stale).toBe(false);
  });

  test("a proposal that is all already-satisfied deletes applies with no commit", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/stale-page.md", "old content\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "delete", path: "wiki/stale-page.md" })],
      baseContents: { "wiki/stale-page.md": "old content\n" },
    });
    await unlink(join(vault, "wiki/stale-page.md"));
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("unreachable");
    expect(result.commit).toBeUndefined();

    // No new commit landed (there was nothing to commit).
    expect(await headSha(vault)).toBe(before);
    expect(await proposalStatus(vault, id)).toBe("applied");

    const json = applyResultJson(result);
    expect(json["status"]).toBe("applied");
    expect(json["commit"]).toBeNull();
  });

  test("diffStat for a delete reports the base line count as removed, zero added", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/stale-page.md", "line1\nline2\nline3\n");
    await enqueueProposal(vault, {
      changes: [fileChange({ kind: "delete", path: "wiki/stale-page.md" })],
      baseContents: { "wiki/stale-page.md": "line1\nline2\nline3\n" },
    });

    const result = await collectProposals(vault);
    // lineDiffStat's split("\n") includes the trailing empty segment after
    // the final newline, so a 3-line file with a trailing newline counts 4.
    expect(result.proposals[0]!.diffStat).toEqual([
      { path: "wiki/stale-page.md", added: 0, removed: 4 },
    ]);
  });

  test("readWorkingFile rethrows non-ENOENT errors (EACCES), which performApply surfaces as invalid", async () => {
    if (process.getuid && process.getuid() === 0) {
      // Running as root bypasses permission bits — skip gracefully.
      return;
    }
    const vault = await initVault();
    await commitFile(vault, "wiki/locked.md", "secret content\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/locked.md", content: "new content\n" })],
      baseContents: { "wiki/locked.md": "secret content\n" },
    });

    const filePath = join(vault, "wiki/locked.md");
    chmodSync(filePath, 0o000);
    try {
      const result = await performApply(vault, id);
      expect(result.status).toBe("invalid");
      if (result.status !== "invalid") throw new Error("unreachable");
      expect(result.message).toContain("apply failed");
      expect(await proposalStatus(vault, id)).toBe("pending");
    } finally {
      chmodSync(filePath, 0o644);
    }
  });

  test("an unknown id is not-found", async () => {
    const vault = await initVault();
    const result = await performApply(vault, 9999);
    expect(result.status).toBe("not-found");
  });

  test("an uninitialized vault is invalid", async () => {
    const notAVault = tempDir("dome-proposals-plain-dir-");
    const result = await performApply(notAVault, 1);
    expect(result.status).toBe("invalid");
  });
});

// ----- performReject -----------------------------------------------------------

describe("performReject", () => {
  test("marks the row rejected and lands no commit", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    const before = await headSha(vault);

    const result = await performReject(vault, id, "not needed");
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("unreachable");
    expect(result.id).toBe(id);

    expect(await headSha(vault)).toBe(before);
    expect(await proposalStatus(vault, id)).toBe("rejected");

    // The proposed content never touched the working file.
    const onDisk = await Bun.file(join(vault, "wiki/note.md")).text();
    expect(onDisk).toBe("line1\n");
  });

  test("a second reject on the same id is not-pending", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    const first = await performReject(vault, id);
    expect(first.status).toBe("rejected");

    const second = await performReject(vault, id);
    expect(second.status).toBe("not-pending");
  });

  test("an unknown id is not-found", async () => {
    const vault = await initVault();
    const result = await performReject(vault, 9999);
    expect(result.status).toBe("not-found");
  });
});
