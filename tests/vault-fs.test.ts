import { describe, test, expect } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { walkMd } from "../src/vault-fs";

describe("walkMd", () => {
  test("yields every .md file under a root, recursively", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-fs-"));
    try {
      await mkdir(join(dir, "a"), { recursive: true });
      await mkdir(join(dir, "b", "c"), { recursive: true });
      await writeFile(join(dir, "a", "1.md"), "x");
      await writeFile(join(dir, "b", "c", "2.md"), "x");
      await writeFile(join(dir, "b", "not-md.txt"), "x");
      const out: string[] = [];
      for await (const p of walkMd(dir)) out.push(p.slice(dir.length));
      expect(out.sort()).toEqual(["/a/1.md", "/b/c/2.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("restricts walk to the given tops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vault-fs-"));
    try {
      await mkdir(join(dir, "wiki"), { recursive: true });
      await mkdir(join(dir, "notes"), { recursive: true });
      await mkdir(join(dir, "raw"), { recursive: true });
      await writeFile(join(dir, "wiki", "w.md"), "x");
      await writeFile(join(dir, "notes", "n.md"), "x");
      await writeFile(join(dir, "raw", "r.md"), "x");
      const out: string[] = [];
      for await (const p of walkMd(dir, { tops: ["wiki", "notes"] })) {
        out.push(p.slice(dir.length));
      }
      expect(out.sort()).toEqual(["/notes/n.md", "/wiki/w.md"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("silently yields nothing for a missing root", async () => {
    const out: string[] = [];
    for await (const p of walkMd("/definitely/does/not/exist/path")) out.push(p);
    expect(out).toEqual([]);
  });
});
