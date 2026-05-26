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

  test("openVault succeeds when vault is a subdirectory of an outer git repo (dogfood case)", async () => {
    // Outer dir has .git/ but no .dome/; inner subdir has .dome/ but no .git/.
    // This is the Dome repo dogfooding its own docs/ as a Dome vault.
    const v = await makeTestVault({ initGit: true, initDome: false });
    try {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const innerPath = join(v.path, "docs");
      await mkdir(join(innerPath, ".dome", "state"), { recursive: true });
      await writeFile(
        join(innerPath, ".dome", "config.yaml"),
        "invariants: {}\nhooks:\n  builtin: {}\n  max_causation_depth: 50\ngit:\n  auto_commit_workflows: true\n",
      );
      await writeFile(
        join(innerPath, ".dome", "page-types.yaml"),
        "defaults: [entity]\nextensions: []\n",
      );
      const result = await openVault(innerPath);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.path).toBe(innerPath);
    } finally {
      await v.cleanup();
    }
  });
});
