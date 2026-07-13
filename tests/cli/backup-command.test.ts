import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("backup restore CLI", () => {
  test("advertises restore and rejects a non-absolute target as structured usage truth", async () => {
    const cli = resolve(import.meta.dir, "../../bin/dome");
    const help = Bun.spawn([cli, "backup", "restore", "--help"], { stdout: "pipe", stderr: "pipe" });
    expect(await help.exited).toBe(0);
    expect(await new Response(help.stdout).text()).toContain("Usage: dome backup restore");

    const restore = Bun.spawn([
      cli, "backup", "restore", "relative-archive.age", "--identity", "relative-identity",
      "--target", "relative-target", "--json",
    ], { stdout: "pipe", stderr: "pipe" });
    expect(await restore.exited).toBe(64);
    const result = JSON.parse(await new Response(restore.stdout).text()) as Record<string, unknown>;
    expect(result).toMatchObject({
      schema: "dome.backup/v1",
      operation: "restore",
      status: "error",
      exitCode: 64,
    });
    expect(result.error).toBe("restore target must be an absolute path");
    expect(JSON.stringify(result)).not.toContain("relative-identity");
  });
});
