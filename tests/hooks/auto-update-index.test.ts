import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { autoUpdateIndex } from "../../src/hooks/auto-update-index";
import { makePrivilegedWriter } from "../../src/privileged-writer";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("auto-update-index hook", () => {
  test("adds an entry to index.md when a wiki page is written", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      const ctx = {
        tools: vault.tools,
        vault: { path: vault.path },
        dispatcher: makePrivilegedWriter(vault.path),
      };
      await autoUpdateIndex({
        kind: "document.written.wiki.entity",
        path: "wiki/entities/danny.md",
        category: "wiki",
        type: "entity",
      }, ctx);
      const idx = await readFile(join(v.path, "index.md"), "utf8");
      expect(idx).toContain("[[wiki/entities/danny]]");
    } finally {
      await v.cleanup();
    }
  });

  test("idempotent: second invocation does not duplicate the entry", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      const ctx = {
        tools: vault.tools,
        vault: { path: vault.path },
        dispatcher: makePrivilegedWriter(vault.path),
      };
      const event = {
        kind: "document.written.wiki.entity",
        path: "wiki/entities/danny.md",
        category: "wiki",
        type: "entity",
      };
      await autoUpdateIndex(event, ctx);
      await autoUpdateIndex(event, ctx);
      const idx = await readFile(join(v.path, "index.md"), "utf8");
      const occurrences = idx.split("[[wiki/entities/danny]]").length - 1;
      expect(occurrences).toBe(1);
    } finally {
      await v.cleanup();
    }
  });
});
