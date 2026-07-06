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
//   - A delete-change proposal is `unsupported` in v1.
//   - performReject CAS-decides the row to `rejected` and lands no commit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { fileChange, type FileChange } from "../../src/core/effect";
import { commitOid, sourceRef, type SourceRef } from "../../src/core/source-ref";
import { runInit } from "../../src/cli/commands/init";
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
    expect(commits[0]!.oid).toBe(result.commit);
    expect(commits[0]!.commit.parent[0]!).toBe(before);
    expect(commits[0]!.commit.message.startsWith(`apply(P${id}):`)).toBe(true);

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

  test("a delete-change proposal is unsupported", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/stale-page.md", "old content\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "delete", path: "wiki/stale-page.md" })],
      baseContents: { "wiki/stale-page.md": "old content\n" },
    });
    const before = await headSha(vault);

    const result = await performApply(vault, id);
    expect(result.status).toBe("unsupported");

    expect(await headSha(vault)).toBe(before);
    expect(await proposalStatus(vault, id)).toBe("pending");
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
