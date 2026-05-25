import { describe, test, expect } from "bun:test";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";

describe("VAULT_IS_GIT_REPO", () => {
  test("openVault on a non-git directory returns vault-not-git-repo", async () => {
    const v = await makeTestVault({ initGit: false });
    try {
      const result = await openVault(v.path);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("vault-not-git-repo");
      }
    } finally {
      await v.cleanup();
    }
  });

  test("openVault on a non-Dome directory (no .dome/) returns vault-not-git-repo or config-invalid", async () => {
    const v = await makeTestVault({ initGit: false, initDome: false });
    try {
      const result = await openVault(v.path);
      expect(result.ok).toBe(false);
    } finally {
      await v.cleanup();
    }
  });

  test("openVault on a valid git+dome directory succeeds", async () => {
    const v = await makeTestVault();
    try {
      const result = await openVault(v.path);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.path).toBe(v.path);
      }
    } finally {
      await v.cleanup();
    }
  });
});
