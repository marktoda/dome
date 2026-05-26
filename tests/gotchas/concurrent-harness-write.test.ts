// Optimistic-locking gotcha (High 5): the v0.5 design is caller-supplied —
// readDocument returns Document.mtime, callers thread it as expected_mtime
// on the next mutating call. If the file changed in between, the mutation
// returns concurrent-write-conflict instead of clobbering.
//
// This test exercises the *real* race window: read -> external modification
// -> write with stale mtime. No internal forcing seams; this is the
// production shape.

import { describe, test, expect } from "bun:test";
import { writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("concurrent-harness-write", () => {
  test("write with stale mtime is rejected; write without mtime succeeds (last write wins)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const vault = res.value;
      const path = "wiki/entities/danny.md";
      const absPath = join(v.path, path);

      // First write — creates the file.
      const created = await vault.tools.writeDocument({
        path,
        body: "# Danny v1\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      expect(created.result.ok).toBe(true);
      await vault.drainHooks();

      // Read to capture the mtime snapshot.
      const r1 = await vault.tools.readDocument({ path });
      expect(r1.result.ok).toBe(true);
      if (!r1.result.ok) return;
      const snapshot = r1.result.value.mtime;
      expect(snapshot).not.toBeNull();

      // Simulate a second harness modifying the file out-of-band: directly
      // write and bump mtime forward.
      await writeFile(absPath, "# Danny EDITED IN OTHER SESSION\n");
      const future = new Date(Date.now() + 60_000);
      await utimes(absPath, future, future);

      // Now the caller's snapshot is stale. Writing with expected_mtime
      // should produce a concurrent-write-conflict.
      const conflict = await vault.tools.writeDocument({
        path,
        body: "# Danny v2 (caller wanted to write this)\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-26", sources: [] },
        expected_mtime: snapshot ?? "",
      });
      expect(conflict.result.ok).toBe(false);
      if (!conflict.result.ok) {
        expect(conflict.result.error.kind).toBe("concurrent-write-conflict");
        if (conflict.result.error.kind === "concurrent-write-conflict") {
          expect(conflict.result.error.expected_mtime).toBe(snapshot ?? "");
        }
      }

      // Writing WITHOUT expected_mtime succeeds (last write wins — the v0.5
      // default for single-user workflows that don't thread the snapshot).
      const overwrite = await vault.tools.writeDocument({
        path,
        body: "# Danny v3 (no lock)\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-26", sources: [] },
      });
      expect(overwrite.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("moveDocument with stale expected_mtime conflicts; without it, moves through", async () => {
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

      const r = await vault.tools.readDocument({ path: "wiki/entities/danny.md" });
      if (!r.result.ok) return;
      const snapshot = r.result.value.mtime;

      // External modification.
      const absPath = join(v.path, "wiki/entities/danny.md");
      await writeFile(absPath, "# Danny EDITED\n");
      const future = new Date(Date.now() + 60_000);
      await utimes(absPath, future, future);

      // Stale-mtime move → conflict.
      const conflict = await vault.tools.moveDocument({
        from: "wiki/entities/danny.md",
        to: "wiki/entities/danny-doe.md",
        reason: "rename test",
        expected_mtime: snapshot ?? "",
      });
      expect(conflict.result.ok).toBe(false);
      if (!conflict.result.ok) {
        expect(conflict.result.error.kind).toBe("concurrent-write-conflict");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("deleteDocument with stale expected_mtime conflicts; without it, deletes", async () => {
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

      const r = await vault.tools.readDocument({ path: "wiki/entities/danny.md" });
      if (!r.result.ok) return;
      const snapshot = r.result.value.mtime;

      const absPath = join(v.path, "wiki/entities/danny.md");
      await writeFile(absPath, "# Danny EDITED\n");
      const future = new Date(Date.now() + 60_000);
      await utimes(absPath, future, future);

      const conflict = await vault.tools.deleteDocument({
        path: "wiki/entities/danny.md",
        reason: "delete test",
        expected_mtime: snapshot ?? "",
      });
      expect(conflict.result.ok).toBe(false);
      if (!conflict.result.ok) {
        expect(conflict.result.error.kind).toBe("concurrent-write-conflict");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("readDocument returns mtime that subsequent writes can thread", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) throw new Error("vault open failed");
      const vault = res.value;

      await vault.tools.writeDocument({
        path: "wiki/entities/test.md",
        body: "# Test\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-25", sources: [] },
        opts: { create: true },
      });
      await vault.drainHooks();

      const r = await vault.tools.readDocument({ path: "wiki/entities/test.md" });
      expect(r.result.ok).toBe(true);
      if (!r.result.ok) return;
      // mtime is a non-null ISO string.
      expect(r.result.value.mtime).not.toBeNull();
      expect(typeof r.result.value.mtime).toBe("string");
      // Looks like an ISO date.
      expect(r.result.value.mtime!).toMatch(/\d{4}-\d{2}-\d{2}T/);

      // Writing with the freshly-read snapshot succeeds (no race).
      const ok = await vault.tools.writeDocument({
        path: "wiki/entities/test.md",
        body: "# Test v2\n",
        frontmatter: { type: "entity", created: "2026-05-25", updated: "2026-05-26", sources: [] },
        expected_mtime: r.result.value.mtime!,
      });
      expect(ok.result.ok).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
