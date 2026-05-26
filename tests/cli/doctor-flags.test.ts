import { describe, test, expect } from "bun:test";
import { domeDoctor } from "../../src/cli/commands/doctor";
import { makeTestVault } from "../helpers/make-test-vault";

describe("dome doctor flags (formerly no-op)", () => {
  test("--drain-hooks calls vault.drainHooks() and exits clean", async () => {
    const v = await makeTestVault();
    try {
      const r = await domeDoctor(v.path, { drainHooks: true });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.exitCode).toBe(0);
      // Info should mention the drain happened, NOT that it was a no-op.
      const drainInfo = r.value.info.find(l => l.startsWith("--drain-hooks:"));
      expect(drainInfo).toBeDefined();
      expect(drainInfo).not.toContain("no-op");
      expect(drainInfo).toContain("drained");
    } finally {
      await v.cleanup();
    }
  });
});
