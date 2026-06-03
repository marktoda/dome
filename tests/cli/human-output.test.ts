import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("human CLI color output", () => {
  test("FORCE_COLOR enables semantic ANSI styling", async () => {
    const result = await runFormatter({ FORCE_COLOR: "1" });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("\u001b[");
    expect(result.stdout).toContain("Dome check");
    expect(result.stdout).toContain("ok");
  });

  test("NO_COLOR disables ANSI styling even when color is forced", async () => {
    const result = await runFormatter({ FORCE_COLOR: "1", NO_COLOR: "1" });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("\u001b[");
    expect(result.stdout.trim()).toBe("Dome check: ok");
  });
});

async function runFormatter(
  env: Record<string, string>,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  Object.assign(childEnv, env);
  if (env.NO_COLOR === undefined) delete childEnv.NO_COLOR;
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "--eval",
      "import { formatHeadline } from './src/cli/human-output.ts'; console.log(formatHeadline('Dome check', 'ok'));",
    ],
    cwd: REPO_ROOT,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}
