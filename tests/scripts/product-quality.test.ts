import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");

describe("product-quality report", () => {
  test("keeps recall as the only gate while vault evidence is optional", async () => {
    const proc = Bun.spawn([process.execPath, "scripts/product-quality.ts"], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      readonly schema: string;
      readonly recall: { readonly passed: boolean };
      readonly garden: unknown;
      readonly retrievalMissEvidence: unknown;
    };
    expect(report).toMatchObject({
      schema: "dome.eval.product-quality/v2",
      recall: { passed: true },
      garden: null,
      retrievalMissEvidence: null,
    });
  });
});
