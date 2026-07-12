import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runInit } from "../../src/cli/commands/init";
import { runSync } from "../../src/cli/commands/sync";
import { getAdoptedRef, getCurrentBranch } from "../../src/adopted-ref";
import { add, commit, probeAncestry } from "../../src/git";
import { createDomeHttpServer } from "../../src/http/server";
import {
  DEFAULT_SOURCE_DOCUMENT_MAX_BYTES,
  readSourceDocument,
  type SourceDocumentReaderDependencies,
} from "../../src/source-document/source-document";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ vault: string; cited: string }> {
  const vault = mkdtempSync(join(tmpdir(), "dome-source-document-"));
  roots.push(vault);
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    expect(await runInit({ path: vault })).toBe(0);
    await mkdir(join(vault, "wiki"), { recursive: true });
    await writeFile(join(vault, "wiki", "source.md"), "# Historical source\n\nexact evidence\n", "utf8");
    await add(vault, "wiki/source.md");
    const cited = await commit({ path: vault, message: "seed exact source" });
    expect(await runSync({ vault, quiet: true })).toBe(0);
    return { vault, cited };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

describe("exact adopted-source reader", () => {
  test("reads path+commit only when the commit is in current adopted history", async () => {
    const { vault, cited } = await fixture();
    const result = await readSourceDocument({ vaultPath: vault, path: "wiki/source.md", commit: cited });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.schema).toBe("dome.source-document/v1");
      expect(result.path).toBe("wiki/source.md");
      expect(result.commit).toBe(cited);
      expect(result.content).toContain("exact evidence");
    }

    await writeFile(join(vault, "wiki", "source.md"), "# Current source\n\nnew evidence\n", "utf8");
    await add(vault, "wiki/source.md");
    await commit({ path: vault, message: "edit exact source" });
    expect(await runSync({ vault, quiet: true })).toBe(0);
    const historical = await readSourceDocument({ vaultPath: vault, path: "wiki/source.md", commit: cited });
    expect(historical).toMatchObject({ status: "ok", commit: cited });
    if (historical.status === "ok") {
      expect(historical.content).toContain("exact evidence");
      expect(historical.content).not.toContain("new evidence");
    }

    await writeFile(join(vault, "wiki", "future.md"), "not adopted\n", "utf8");
    await add(vault, "wiki/future.md");
    const future = await commit({ path: vault, message: "unadopted future" });
    expect((await readSourceDocument({ vaultPath: vault, path: "wiki/future.md", commit: future })).status)
      .toBe("not-adopted");

    const divergent = await divergentCommit(vault, cited);
    expect((await readSourceDocument({ vaultPath: vault, path: "wiki/source.md", commit: divergent })).status)
      .toBe("not-adopted");
  }, 120_000);

  test("refuses traversal, aliases, invalid object ids, missing paths, and oversized content", async () => {
    const { vault, cited } = await fixture();
    for (const path of ["../secret", "/etc/passwd", "wiki\\source.md", "wiki//source.md"]) {
      expect((await readSourceDocument({ vaultPath: vault, path, commit: cited })).status).toBe("invalid-path");
    }
    expect((await readSourceDocument({ vaultPath: vault, path: "wiki/source.md", commit: "HEAD" })).status)
      .toBe("invalid-commit");
    expect((await readSourceDocument({ vaultPath: vault, path: "wiki/missing.md", commit: cited })).status)
      .toBe("not-found");
    expect((await readSourceDocument({ vaultPath: vault, path: "wiki/source.md", commit: cited, maxBytes: 4 })).status)
      .toBe("too-large");
    expect((await readSourceDocument({ vaultPath: vault, path: ".dome/config.yaml", commit: cited })).status)
      .toBe("invalid-path");
    expect((await readSourceDocument({ vaultPath: vault, path: "wiki/source.txt", commit: cited })).status)
      .toBe("invalid-path");
  }, 120_000);

  test("preflights a blob over 512 KiB and never calls the content reader", async () => {
    let contentRead = false;
    const commitId = "a".repeat(40);
    const dependencies: SourceDocumentReaderDependencies = {
      getCurrentBranch: async () => "main",
      getAdoptedRef: async () => commitId,
      probeAncestry: async () => ({ kind: "ancestor" }),
      blobSizeAtCommit: async () => DEFAULT_SOURCE_DOCUMENT_MAX_BYTES + 1,
      readBlob: async () => { contentRead = true; return "must not allocate"; },
    };
    expect((await readSourceDocument({
      vaultPath: "/unused",
      path: "wiki/large.md",
      commit: commitId,
    }, dependencies)).status).toBe("too-large");
    expect(contentRead).toBe(false);
  });

  test("accepts exact current adopted equality without a strict ancestry lookup", async () => {
    const commitId = "a".repeat(40);
    let ancestryCalled = false;
    const dependencies: SourceDocumentReaderDependencies = {
      getCurrentBranch: async () => "main",
      getAdoptedRef: async () => commitId,
      probeAncestry: async () => { ancestryCalled = true; return { kind: "not-ancestor" }; },
      blobSizeAtCommit: async () => 8,
      readBlob: async () => "evidence",
    };
    expect((await readSourceDocument({
      vaultPath: "/unused",
      path: "wiki/source.md",
      commit: commitId,
    }, dependencies)).status).toBe("ok");
    expect(ancestryCalled).toBe(false);
  });

  test("rejects a real adopted blob over 512 KiB through Git metadata", async () => {
    const { vault } = await fixture();
    await writeFile(
      join(vault, "wiki", "large.md"),
      `# Large\n\n${"x".repeat(DEFAULT_SOURCE_DOCUMENT_MAX_BYTES)}`,
      "utf8",
    );
    await add(vault, "wiki/large.md");
    await commit({ path: vault, message: "seed oversized source" });
    expect(await runSync({ vault, quiet: true })).toBe(0);
    const branch = await getCurrentBranch(vault);
    if (branch === null) throw new Error("fixture branch missing");
    const largeCommit = await getAdoptedRef(vault, branch);
    if (largeCommit === null) throw new Error("fixture adopted ref missing");
    expect((await readSourceDocument({
      vaultPath: vault,
      path: "wiki/large.md",
      commit: largeCommit,
    })).status).toBe("too-large");
  }, 120_000);

  test("maps ancestry and blob I/O failures to typed unavailable", async () => {
    const commitId = "a".repeat(40);
    const dependencies: SourceDocumentReaderDependencies = {
      getCurrentBranch: async () => "main",
      getAdoptedRef: async () => commitId,
      probeAncestry: async () => { throw new Error("repository I/O failed"); },
      blobSizeAtCommit: async () => { throw new Error("must not run"); },
      readBlob: async () => { throw new Error("must not run"); },
    };
    expect(await readSourceDocument({
      vaultPath: "/unavailable",
      path: "wiki/source.md",
      commit: commitId,
    }, dependencies)).toMatchObject({ schema: "dome.source-document/v1", status: "unavailable" });

    const readFailure: SourceDocumentReaderDependencies = {
      ...dependencies,
      probeAncestry: async () => ({ kind: "ancestor" }),
      blobSizeAtCommit: async () => 10,
      readBlob: async () => { throw new Error("blob read I/O failed"); },
    };
    expect((await readSourceDocument({
      vaultPath: "/unavailable",
      path: "wiki/source.md",
      commit: commitId,
    }, readFailure)).status).toBe("unavailable");
  });

  test("a real Git adapter failure is unavailable, never not-adopted", async () => {
    const notARepository = mkdtempSync(join(tmpdir(), "dome-source-broken-git-"));
    roots.push(notARepository);
    const cited = "a".repeat(40);
    const adopted = "b".repeat(40);
    expect(await probeAncestry({
      path: notARepository,
      ancestor: cited,
      descendant: adopted,
    })).toEqual({ kind: "unavailable" });

    const result = await readSourceDocument({
      vaultPath: notARepository,
      path: "wiki/source.md",
      commit: cited,
    }, {
      getCurrentBranch: async () => "main",
      getAdoptedRef: async () => adopted,
      probeAncestry,
      blobSizeAtCommit: async () => { throw new Error("must not read metadata"); },
      readBlob: async () => { throw new Error("must not read content"); },
    });
    expect(result).toMatchObject({ schema: "dome.source-document/v1", status: "unavailable" });
  });

  test("HTTP exposes the shared explicit-status contract behind read capability", async () => {
    const { vault, cited } = await fixture();
    const operationClasses: string[] = [];
    const server = createDomeHttpServer({
      vaultPath: vault,
      token: "source-test-token",
      operationScheduler: {
        run: async (operationClass, operation) => {
          operationClasses.push(operationClass);
          return operation({ signal: new AbortController().signal });
        },
      },
    });
    try {
      const request = (query: string, token = "source-test-token") => server.fetch(new Request(
        `http://127.0.0.1/source?${query}`,
        { headers: { authorization: `Bearer ${token}` } },
      ));
      const ok = await request(new URLSearchParams({ path: "wiki/source.md", commit: cited }).toString());
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({
        schema: "dome.source-document/v1",
        status: "ok",
        path: "wiki/source.md",
        commit: cited,
      });
      expect(operationClasses).toEqual(["immutable-adopted-read"]);

      const invalid = await request(new URLSearchParams({ path: "../secret", commit: cited }).toString());
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ schema: "dome.source-document/v1", status: "invalid-path" });
      expect((await request(new URLSearchParams({ path: "wiki/source.md", commit: cited }).toString(), "wrong")).status)
        .toBe(401);
    } finally {
      await server.close();
    }
  }, 120_000);
});

async function divergentCommit(vault: string, treeFrom: string): Promise<string> {
  const tree = await nativeGit(vault, ["rev-parse", `${treeFrom}^{tree}`]);
  return nativeGit(vault, ["commit-tree", tree], "divergent source history\n");
}

async function nativeGit(vault: string, args: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(["git", "-C", vault, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dome Test",
      GIT_AUTHOR_EMAIL: "dome@example.invalid",
      GIT_COMMITTER_NAME: "Dome Test",
      GIT_COMMITTER_EMAIL: "dome@example.invalid",
    },
    stdin: stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (stdin !== undefined && proc.stdin !== undefined) {
    proc.stdin.write(stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}
