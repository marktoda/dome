import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runCli, ExitCode } from "../../src/cli/cli";

describe("runCli", () => {
  test("--help prints usage", async () => {
    const code = await runCli(["--help"]);
    expect(code).toBe(ExitCode.Usage);
  });

  test("init <path> initializes vault", async () => {
    const base = await mkdtemp(join(tmpdir(), "dome-cli-"));
    const target = join(base, "v");
    try {
      const code = await runCli(["init", target]);
      expect(code).toBe(ExitCode.Success);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("unknown command returns Usage exit code", async () => {
    const code = await runCli(["nonsense"]);
    expect(code).toBe(ExitCode.Usage);
  });
});
