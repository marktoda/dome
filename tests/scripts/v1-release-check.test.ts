import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RELEASE_CHECK_SCRIPT = join(REPO_ROOT, "scripts", "v1-release-check.ts");

describe("v1 release-check script", () => {
  test("help describes the final V1 gates", async () => {
    const result = await runScript(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Runs the final V1 release gates");
    expect(result.stdout).toContain("bun run v1:check");
    expect(result.stdout).toContain(
      "bun run v1:dogfood-preflight -- --require-ready",
    );
    expect(result.stdout).toContain(
      "bun run v1:dogfood-report -- --require-ready",
    );
  });

  test("dry-run text prints every gate without running it", async () => {
    const result = await runScript(["--dry-run"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("V1 release check plan:");
    expect(result.stdout).toContain(
      "- Implementation gates: bun run v1:check",
    );
    expect(result.stdout).toContain(
      "- Current dogfood collection readiness: " +
        "bun run v1:dogfood-preflight -- --require-ready",
    );
    expect(result.stdout).toContain(
      "- M10 release-soak evidence: " +
        "bun run v1:dogfood-report -- --require-ready",
    );
  });

  test("dry-run JSON emits stable gate ids and commands", async () => {
    const result = await runScript(["--dry-run", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as {
      readonly status: string;
      readonly gates: ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly command: ReadonlyArray<string>;
      }>;
    };
    expect(report.status).toBe("dry-run");
    expect(report.gates.map((gate) => gate.id)).toEqual([
      "implementation",
      "collection-readiness",
      "release-soak",
    ]);
    expect(report.gates.map((gate) => gate.command)).toEqual([
      ["bun", "run", "v1:check"],
      [
        "bun",
        "run",
        "v1:dogfood-preflight",
        "--",
        "--require-ready",
      ],
      ["bun", "run", "v1:dogfood-report", "--", "--require-ready"],
    ]);
  });
});

type ScriptResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runScript(args: ReadonlyArray<string>): Promise<ScriptResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, RELEASE_CHECK_SCRIPT, ...args],
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
