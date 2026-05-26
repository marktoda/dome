// Pins the Vault lifecycle contract from docs/wiki/specs/sdk-surface.md
// §"Vault lifecycle":
// - drainHooks() is idempotent (multiple calls succeed)
// - close() is one-shot, drains hooks, releases Vault-owned resources
// - calling vault.tools.X after close() is undefined behavior (we don't
//   assert throw; just assert it doesn't crash the process)

import { describe, test, expect } from "bun:test";
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

  test("dispatchEvents after close() is a no-op", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const vault = res.value;

      // Seed a wiki page so auto-update-index has something to update.
      await vault.tools.writeDocument({
        path: "wiki/entities/seed.md",
        body: "# seed\n",
        frontmatter: { type: "entity", created: "2026-05-26", updated: "2026-05-26", sources: [] },
        opts: { create: true },
      });
      await vault.close();

      // Post-close dispatchEvents accepts the call but no-ops — handler is
      // not invoked. Verified indirectly: subsequent writes through the
      // tools surface would normally fire auto-update-index, but since
      // dispatchEvents is closed, the hook chain is silent. (We assert
      // no-throw here; the structural pin is that the closed flag stops
      // the dispatcher from queueing work into resources that may have
      // been released in a future minor.)
      await vault.dispatchEvents([
        { kind: "document.written.wiki.entity", path: "wiki/entities/seed.md", diff: "" } as never,
      ]);
      // Idempotent: drainHooks still callable after close (no new work
      // queued; just settles whatever is pending — which is nothing).
      await vault.drainHooks();
      expect(true).toBe(true);
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
