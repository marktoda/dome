// Optimistic-locking gotcha: when two harness sessions write the same file
// the second write must see a `concurrent-write-conflict` ToolError rather
// than silently clobbering.
//
// The Tools take an mtime snapshot at read time and re-check the on-disk
// mtime before the write. In production both reads see the live fs mtime;
// here we force a stale snapshot via the test-only `__forceExpectedMtime`
// seam so the conflict path is exercised deterministically.

import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("concurrent-harness-write", () => {
  test("writeDocument returns concurrent-write-conflict when mtime snapshot is stale", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const vault = res.value;

      // First write — creates the file.
      const created = await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny v1\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(created.result.ok).toBe(true);
      await vault.drainHooks();

      // Second write with a stale snapshot — must conflict.
      const conflict = await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny v2\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        __forceExpectedMtime: "1970-01-01T00:00:00.000Z",
      });
      expect(conflict.result.ok).toBe(false);
      if (!conflict.result.ok) {
        expect(conflict.result.error.kind).toBe("concurrent-write-conflict");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("moveDocument returns concurrent-write-conflict when mtime snapshot is stale", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const vault = res.value;

      await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      await vault.drainHooks();

      const conflict = await vault.tools.moveDocument({
        from: "wiki/entities/danny.md",
        to: "wiki/entities/danny-doe.md",
        reason: "rename test",
        __forceExpectedMtime: "1970-01-01T00:00:00.000Z",
      });
      expect(conflict.result.ok).toBe(false);
      if (!conflict.result.ok) {
        expect(conflict.result.error.kind).toBe("concurrent-write-conflict");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("deleteDocument returns concurrent-write-conflict when mtime snapshot is stale", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const vault = res.value;

      await vault.tools.writeDocument({
        path: "wiki/entities/danny.md",
        body: "# Danny\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      await vault.drainHooks();

      const conflict = await vault.tools.deleteDocument({
        path: "wiki/entities/danny.md",
        reason: "delete test",
        __forceExpectedMtime: "1970-01-01T00:00:00.000Z",
      });
      expect(conflict.result.ok).toBe(false);
      if (!conflict.result.ok) {
        expect(conflict.result.error.kind).toBe("concurrent-write-conflict");
      }
    } finally {
      await v.cleanup();
    }
  });
});
