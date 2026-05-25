import { describe, test, expect } from "bun:test";
import { makeFixtureVault } from "../../src/eval/fixture-vault";
import { openVault } from "../../src/vault";

describe("eval fixture vault", () => {
  test("makeFixtureVault produces a working git-backed vault", async () => {
    const fx = await makeFixtureVault({
      files: {
        "wiki/entities/test.md": "---\ntype: entity\n---\n# Test",
      },
    });
    try {
      const res = await openVault(fx.path);
      expect(res.ok).toBe(true);
    } finally {
      await fx.cleanup();
    }
  });
});
