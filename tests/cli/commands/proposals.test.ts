// `dome proposals` / `dome apply` / `dome reject` — end-to-end tests for the
// CLI bindings over src/surface/proposals.ts (the settle pattern; see
// tests/surface/proposals.test.ts for the collector-level coverage). Mirrors
// tests/cli/commands/settle.test.ts's fixture shape: a real temp git vault,
// real commits, no mocks. Proposals are enqueued directly through the Task 1
// store API (`enqueuePendingProposal`) since the engine sink is out of scope
// here — see tests/surface/proposals.test.ts for the same pattern.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runInit } from "../../../src/cli/commands/init";
import { runApply } from "../../../src/cli/commands/apply";
import { runProposals } from "../../../src/cli/commands/proposals";
import { runReject } from "../../../src/cli/commands/reject";
import { fileChange, type FileChange } from "../../../src/core/effect";
import { commitOid, sourceRef } from "../../../src/core/source-ref";
import { commitSingleFileOnHead, resolveRef } from "../../../src/git";
import { openProposalsDb } from "../../../src/proposals/db";
import { enqueuePendingProposal } from "../../../src/proposals/pending-proposals";

// ----- Console capture -------------------------------------------------------

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...parts: unknown[]) => {
    logs.push(parts.map((p) => String(p)).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    errors.push(parts.map((p) => String(p)).join(" "));
  };
});

let tempDirs: string[] = [];

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
  const vault = tempDir("dome-proposals-cli-vault-");
  expect(await runInit({ path: vault })).toBe(0);
  logs = [];
  errors = [];
  return vault;
}

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

async function headSha(vault: string): Promise<string> {
  return resolveRef({ path: vault, ref: "HEAD" });
}

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
  const opened = await openProposalsDb({
    path: join(vault, ".dome", "state", "proposals.db"),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("open failed");
  try {
    const result = enqueuePendingProposal(opened.value.db, {
      processorId: overrides.processorId ?? "dome.test.garden",
      extensionId: "test",
      runId: "run_1",
      reason: overrides.reason ?? "tidy up the note",
      changes: overrides.changes,
      sourceRefs: [sourceRef({ commit: commitOid("a".repeat(40)), path: "wiki/note.md" })],
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

// ----- runProposals -----------------------------------------------------------

describe("runProposals", () => {
  test("prints a friendly empty line when there is nothing awaiting review", async () => {
    const vault = await initVault();

    const code = await runProposals({ vault });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain("nothing awaiting review");
  });

  test("renders the P<id> block with age, path, diff stat, reason, and verb hints", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\nline2\n");
    const id = await enqueueProposal(vault, {
      processorId: "dome.agent.consolidate",
      reason: "split oversized entity page",
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\nline3\n" })],
      baseContents: { "wiki/note.md": "line1\nline2\n" },
    });

    const code = await runProposals({ vault });
    expect(code).toBe(0);
    const out = logs.join("\n");
    expect(out).toContain(`P${id}  dome.agent.consolidate`);
    expect(out).toContain("wiki/note.md");
    expect(out).toContain("(+1 −0)");
    expect(out).toContain("split oversized entity page");
    expect(out).toContain(`apply: dome apply ${id}`);
    expect(out).toContain(`reject: dome reject ${id}`);
  });

  test("marks a stale row", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    await writeFile(join(vault, "wiki/note.md"), "someone edited this already\n", "utf8");

    const code = await runProposals({ vault });
    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("[stale — regenerates on next garden pass]");
  });

  test("--json emits the dome.proposals/v1 payload with the enqueued row", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    const code = await runProposals({ vault, json: true });
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.proposals/v1");
    expect(payload.proposals).toHaveLength(1);
    expect(payload.proposals[0].id).toBe(id);
    expect(payload.proposals[0].status).toBe("pending");
  });

  test("--all includes rejected rows; default is pending-only", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    expect((await runReject({ id: String(id), vault })) ).toBe(0);
    logs = [];

    expect(await runProposals({ vault, json: true })).toBe(0);
    expect(JSON.parse(logs.join("\n")).proposals).toHaveLength(0);
    logs = [];

    expect(await runProposals({ vault, all: true, json: true })).toBe(0);
    const all = JSON.parse(logs.join("\n"));
    expect(all.proposals).toHaveLength(1);
    expect(all.proposals[0].status).toBe("rejected");
  });
});

// ----- runApply -----------------------------------------------------------

describe("runApply", () => {
  test("writes the file, commits, exits 0, and prints one line", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    const before = await headSha(vault);

    const code = await runApply({ id: String(id), vault });
    expect(code).toBe(0);
    expect(await headSha(vault)).not.toBe(before);
    expect(errors).toEqual([]);
    expect(logs.join("\n")).toContain(`dome apply: applied P${id}`);
  });

  test("--json emits the dome.apply/v1 applied payload", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    const code = await runApply({ id: String(id), vault, json: true });
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.apply/v1");
    expect(payload.status).toBe("applied");
    expect(payload.id).toBe(id);
    expect(typeof payload.commit).toBe("string");
  });

  test("an unknown id is not-found and exits 64", async () => {
    const vault = await initVault();

    const code = await runApply({ id: "9999", vault });
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("dome apply:");
  });

  test("a non-numeric id is invalid and exits 64", async () => {
    const vault = await initVault();

    const code = await runApply({ id: "not-a-number", vault });
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("not a valid proposal id");
  });

  test("a stale proposal is left untouched and exits 64", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    await writeFile(join(vault, "wiki/note.md"), "drifted\n", "utf8");
    const before = await headSha(vault);

    const code = await runApply({ id: String(id), vault });
    expect(code).toBe(64);
    expect(await headSha(vault)).toBe(before);
    expect(errors.join("\n")).toContain("stale");
  });
});

// ----- runReject -----------------------------------------------------------

describe("runReject", () => {
  test("marks rejected, lands no commit, exits 0, and prints one line", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });
    const before = await headSha(vault);

    const code = await runReject({ id: String(id), vault, note: "not needed" });
    expect(code).toBe(0);
    expect(await headSha(vault)).toBe(before);
    expect(logs.join("\n")).toContain(`dome reject: rejected P${id}`);
  });

  test("--json emits the dome.reject/v1 payload", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    const code = await runReject({ id: String(id), vault, json: true });
    expect(code).toBe(0);
    const payload = JSON.parse(logs.join("\n"));
    expect(payload.schema).toBe("dome.reject/v1");
    expect(payload.status).toBe("rejected");
    expect(payload.id).toBe(id);
  });

  test("a second reject on the same id is not-pending and exits 64", async () => {
    const vault = await initVault();
    await commitFile(vault, "wiki/note.md", "line1\n");
    const id = await enqueueProposal(vault, {
      changes: [fileChange({ kind: "write", path: "wiki/note.md", content: "line1\nline2\n" })],
      baseContents: { "wiki/note.md": "line1\n" },
    });

    expect(await runReject({ id: String(id), vault })).toBe(0);
    const code = await runReject({ id: String(id), vault });
    expect(code).toBe(64);
    expect(errors.join("\n")).toContain("already rejected");
  });
});
