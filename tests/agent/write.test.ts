import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import fs from "node:fs";
import { createDocument, editDocument, AgentWriteError } from "../../src/agent/write";

async function tempVault(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "dome-agent-write-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  await mkdir(join(dir, "wiki"), { recursive: true });
  await writeFile(join(dir, "wiki", "seed.md"), "# Seed\n", "utf8");
  await git.add({ fs, dir, filepath: "wiki/seed.md" });
  await git.commit({ fs, dir, message: "seed", author: { name: "t", email: "t@t" } });
  return dir;
}

const CTX = (vaultPath: string) => ({ vaultPath, modelId: "claude-sonnet-4-5" });

describe("createDocument", () => {
  let vault: string;
  beforeEach(async () => { vault = await tempVault(); });

  test("writes a new page, commits it with a Dome-Agent trailer, returns the change", async () => {
    const change = await createDocument(CTX(vault), { path: "wiki/new.md", content: "# New\nbody\n" });
    expect(change).toEqual({ path: "wiki/new.md", kind: "create" });
    expect(await readFile(join(vault, "wiki/new.md"), "utf8")).toBe("# New\nbody\n");
    const head = await git.resolveRef({ fs, dir: vault, ref: "HEAD" });
    const { commit } = await git.readCommit({ fs, dir: vault, oid: head });
    expect(commit.message).toContain("author: create wiki/new.md");
    expect(commit.message).toContain("Dome-Agent: claude-sonnet-4-5");
    expect(commit.author.name).toBe("dome agent");
  });

  test("rejects an existing path", async () => {
    await expect(createDocument(CTX(vault), { path: "wiki/seed.md", content: "x" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });

  test("rejects .dome/, absolute, escape, and non-.md paths", async () => {
    for (const p of [".dome/config.yaml", "/etc/passwd", "../outside.md", "wiki/notes.txt"]) {
      await expect(createDocument(CTX(vault), { path: p, content: "x" }))
        .rejects.toBeInstanceOf(AgentWriteError);
    }
  });

  test("rejects generated/frozen/raw paths via the default write scope", async () => {
    for (const p of ["index.md", "log.md", "inbox/raw/x.md"]) {
      await expect(createDocument(CTX(vault), { path: p, content: "x\n" }))
        .rejects.toBeInstanceOf(AgentWriteError);
    }
  });
});

describe("editDocument", () => {
  let vault: string;
  beforeEach(async () => { vault = await tempVault(); });

  test("replaces a unique substring, commits, returns the change", async () => {
    await writeFile(join(vault, "wiki/seed.md"), "- [ ] do the thing\n", "utf8");
    await git.add({ fs, dir: vault, filepath: "wiki/seed.md" });
    await git.commit({ fs, dir: vault, message: "task", author: { name: "t", email: "t@t" } });
    const change = await editDocument(CTX(vault), { path: "wiki/seed.md", old_string: "- [ ] do the thing", new_string: "- [x] do the thing" });
    expect(change).toEqual({ path: "wiki/seed.md", kind: "edit" });
    expect(await readFile(join(vault, "wiki/seed.md"), "utf8")).toBe("- [x] do the thing\n");
  });

  test("errors when old_string is missing", async () => {
    await expect(editDocument(CTX(vault), { path: "wiki/seed.md", old_string: "nope", new_string: "x" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });

  test("errors when old_string is not unique", async () => {
    await writeFile(join(vault, "wiki/seed.md"), "dup\ndup\n", "utf8");
    await git.add({ fs, dir: vault, filepath: "wiki/seed.md" });
    await git.commit({ fs, dir: vault, message: "dup", author: { name: "t", email: "t@t" } });
    await expect(editDocument(CTX(vault), { path: "wiki/seed.md", old_string: "dup", new_string: "x" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });

  test("errors when the file does not exist", async () => {
    await expect(editDocument(CTX(vault), { path: "wiki/ghost.md", old_string: "a", new_string: "b" }))
      .rejects.toBeInstanceOf(AgentWriteError);
  });
});
