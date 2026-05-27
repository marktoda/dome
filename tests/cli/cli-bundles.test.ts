import { describe, test, expect } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runCli, ExitCode } from "../../src/cli/cli";
import { makeTestVault } from "../helpers/make-test-vault";

describe("runCli with bundle CLI commands", () => {
  test("registers bundle CLI command and invokes it; bundle action runs to completion", async () => {
    const v = await makeTestVault();
    try {
      const bundleDir = join(v.path, ".dome", "extensions", "hello-world");
      const cliDir = join(bundleDir, "cli");
      await mkdir(cliDir, { recursive: true });
      await writeFile(
        join(bundleDir, "manifest.yaml"),
        "name: hello-world\nversion: 1.0.0\n",
      );
      // The CLI module must export a `command` object the loader registers
      // with Commander. The action writes a sentinel file so the test can
      // observe that registration + dispatch worked.
      const sentinel = join(v.path, "hello-bundle-ran.flag");
      await writeFile(
        join(cliDir, "say-hi.ts"),
        `import { writeFile } from "node:fs/promises";
export const command = {
  name: "say-hi",
  description: "Say hi from the hello-world bundle.",
  action: async () => {
    await writeFile(${JSON.stringify(sentinel)}, "ran", "utf8");
    return 0;
  },
};
`,
      );

      // Invoke the bundle-contributed command. The `--vault` flag tells the
      // CLI which vault to inspect for bundles (otherwise it uses CWD).
      const code = await runCli(["--vault", v.path, "say-hi"]);
      expect(code).toBe(ExitCode.Success);

      // Verify the action actually ran.
      const { existsSync } = await import("node:fs");
      expect(existsSync(sentinel)).toBe(true);
    } finally {
      await v.cleanup();
    }
  });

  test("no bundles installed: --help still exits 0 (no regression)", async () => {
    const v = await makeTestVault();
    try {
      const code = await runCli(["--vault", v.path, "--help"]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      await v.cleanup();
    }
  });
});
