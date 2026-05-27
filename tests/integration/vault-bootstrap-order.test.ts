// tests/integration/vault-bootstrap-order.test.ts
//
// Regression test: with the vaultRef setter pattern (B4), the bootstrap-section
// order inside openVault is no longer load-bearing. The three earlier
// positional-ordering rules (TDZ closure on `tools`, "loadDeclarativeHooks
// LAST", cycle-listener wiring window) collapsed into one explicit step:
// `vaultRef.current = vault` after closures are constructed.
//
// A future contributor restructuring openVault for clarity will not silently
// regress vault construction — this test catches it by exercising the vault
// end-to-end: open, write through the bound tool surface (which fires
// dispatchEvents internally via wrapMutatingInvoke), drain async hooks
// (auto-update-index + EVERY_WRITE_IS_LOGGED must land their effects), and
// close cleanly.
//
// See docs/wiki/specs/sdk-surface.md §"Composable construction" and the
// vault-bootstrap-temporal-dead-zone scar this refactor eliminated.

import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domeInit } from "../../src/cli/commands/init";
import { openVault } from "../../src/vault";

describe("vault-bootstrap-order regression", () => {
  test("openVault returns a working Vault end-to-end under the vaultRef shape", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-bootstrap-order-"));
    const vaultPath = join(base, "vault");
    try {
      // Bootstrap a real vault — exercises the same path production uses.
      const initRes = await domeInit(vaultPath);
      expect(initRes.ok).toBe(true);
      if (!initRes.ok) return;

      // Open the vault. With the vaultRef setter pattern, openVault composes
      // loadVaultConfig + buildBuiltinHookRegistry + wireDispatcher and
      // publishes the Vault to vaultRef.current after closures are built.
      const openRes = await openVault(vaultPath);
      expect(openRes.ok).toBe(true);
      if (!openRes.ok) return;
      const vault = openRes.value;

      // Every Vault field is populated — a missing field would surface as
      // undefined here and fail subsequent calls.
      expect(vault.path).toBe(vaultPath);
      expect(vault.config).toBeDefined();
      expect(vault.pageTypes).toBeDefined();
      expect(vault.tools).toBeDefined();
      expect(vault.dispatchEvents).toBeDefined();
      expect(vault.drainHooks).toBeDefined();
      expect(vault.rebuildIndex).toBeDefined();
      expect(vault.close).toBeDefined();

      // Write through the bound tool surface. wrapMutatingInvoke fires
      // dispatchEvents internally — if vaultRef.current were null at this
      // point, the dispatch would silently no-op and the auto-update-index
      // hook would never run, leaving index.md empty. The downstream
      // assertion on index.md catches that regression.
      const writeRes = await vault.tools.writeDocument({
        path: "wiki/entities/test.md",
        body: "# Test\n\nA test entity pinning the bootstrap order.",
        frontmatter: {
          type: "entity",
          created: "2026-05-26",
          updated: "2026-05-26",
          sources: [],
        },
        opts: { create: true, reason: "named_explicitly" },
      });
      expect(writeRes.result.ok).toBe(true);

      // Drain async hooks. auto-update-index and log appends are async; if
      // the dispatcher were misconfigured (e.g., closures captured a stale
      // vault reference), drain would either hang or settle without firing
      // the handlers.
      await vault.drainHooks();

      // index.md got an entry — proves auto-update-index actually ran via
      // dispatchEvents. This is the most sensitive load-bearing check: a
      // broken decomposition where dispatchEvents silently no-ops would
      // leave index.md missing or empty.
      expect(existsSync(join(vaultPath, "index.md"))).toBe(true);
      const indexContent = await readFile(join(vaultPath, "index.md"), "utf8");
      expect(indexContent).toContain("[[wiki/entities/test]]");

      // log.md grew — proves EVERY_WRITE_IS_LOGGED still fires.
      const logContent = await readFile(join(vaultPath, "log.md"), "utf8");
      const logEntries = logContent.match(/^## \[/gm) ?? [];
      expect(logEntries.length).toBeGreaterThanOrEqual(2);

      // close() drains and flips the closed flag — must complete without
      // throwing.
      await vault.close();

      // Post-close dispatchEvents is a silent no-op (the vaultRef pattern
      // preserves this semantic from the pre-refactor shape).
      await vault.dispatchEvents([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
