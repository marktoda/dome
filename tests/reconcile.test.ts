import { describe, test, expect } from "bun:test";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { reconcile } from "../src/reconcile";
import { openVault } from "../src/vault";
import { makeTestVault } from "./helpers/make-test-vault";

describe("dome reconcile", () => {
  test("phase 1: fires document.written.inbox.<bucket> for each inbox file", async () => {
    const v = await makeTestVault();
    try {
      await writeFile(join(v.path, "inbox", "raw", "test-capture.md"), "captured thought");
      const res = await openVault(v.path);
      if (!res.ok) return;
      const events: string[] = [];
      const out = await reconcile(res.value, {
        onEvent: (e) => {
          events.push(e.kind);
        },
      });
      expect(out.ok).toBe(true);
      expect(events.some(e => e === "document.written.inbox.raw")).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("phase 2: fires document.written.<category>.<type> for changes since last-reconciled-sha", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const vault = res.value;
      await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      const events: string[] = [];
      const out = await reconcile(vault, {
        onEvent: (e) => {
          events.push(e.kind);
        },
      });
      expect(out.ok).toBe(true);
      expect(events.some(e => e === "document.written.wiki.entity")).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("refuses to run mid-merge", async () => {
    const v = await makeTestVault();
    try {
      // Simulate a mid-merge state by writing MERGE_HEAD into .git/.
      await mkdir(join(v.path, ".git"), { recursive: true });
      await writeFile(join(v.path, ".git", "MERGE_HEAD"), "fakehash");
      const res = await openVault(v.path);
      if (!res.ok) return;
      const out = await reconcile(res.value, { onEvent: () => {} });
      expect(out.ok).toBe(false);
    } finally {
      await v.cleanup();
    }
  });
});
