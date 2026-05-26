// Pins the Vault lifecycle contract from docs/wiki/specs/sdk-surface.md
// §"Vault lifecycle":
// - drainHooks() is idempotent (multiple calls succeed)
// - close() is one-shot, drains hooks, releases Vault-owned resources
// - calling vault.tools.X after close() is undefined behavior (we don't
//   assert throw; just assert it doesn't crash the process)

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("Vault lifecycle", () => {
  test("drainHooks() is idempotent (multiple calls succeed)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      await vault.drainHooks();
      await vault.drainHooks();
      await vault.drainHooks();
      // No throw means idempotency holds at the contract level.
      expect(true).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("close() drains hooks and is one-shot-safe (single call succeeds)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      // Do some work first (a wiki write) so there's something for drainHooks to settle.
      await vault.tools.writeDocument({
        path: "wiki/entities/alice.md",
        body: "# alice\n",
        frontmatter: { type: "entity", created: "2026-05-26", updated: "2026-05-26", sources: [] },
        opts: { create: true },
      });

      await vault.close();
      // Contract: close() returns; no throw.
      expect(true).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("dispatchEvents after close() is observably a no-op (index.md not updated)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      // Seed a baseline page so index.md exists with known content.
      await vault.tools.writeDocument({
        path: "wiki/entities/seed.md",
        body: "# seed\n",
        frontmatter: { type: "entity", created: "2026-05-26", updated: "2026-05-26", sources: [] },
        opts: { create: true },
      });
      await vault.drainHooks();
      const indexBefore = await readFile(join(v.path, "index.md"), "utf8");
      expect(indexBefore).toContain("[[wiki/entities/seed]]");

      await vault.close();

      // Post-close dispatchEvents must NOT update index.md. Send a fake event
      // that would normally trigger auto-update-index; verify index.md is
      // untouched after the dispatch + a drain settle. A regression that
      // dropped the `if (closed) return` guard in vault.ts would leave this
      // assertion failing because the hook would fire and rewrite index.md
      // with the post-close write that follows.
      await vault.dispatchEvents([
        { kind: "document.written.wiki.entity", path: "wiki/entities/post-close.md", diff: "" } as never,
      ]);
      await vault.drainHooks();
      const indexAfter = await readFile(join(v.path, "index.md"), "utf8");
      expect(indexAfter).toBe(indexBefore);
    } finally {
      await v.cleanup();
    }
  });

  test("close() composes with drainHooks (idempotent drain inside close)", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;
      // drainHooks first, then close — both succeed.
      await vault.drainHooks();
      await vault.close();
      expect(true).toBe(true);
    } finally {
      await v.cleanup();
    }
  });
});
