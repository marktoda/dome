import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("v1 LLM smoke fixture", () => {
  test("uses minimal init and explicitly owns its optional model fixture", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "..", "scripts", "v1-llm-smoke.ts"),
      "utf8",
    );
    expect(source).toContain('await runDome(["init", vaultPath]);');
    expect(source).not.toContain("--with-model-provider");
    expect(source).not.toContain("--with-source");
    expect(source).toContain('join(repoRoot, "assets", "model-providers", "anthropic.ts")');
    expect(source).toContain('command: ["bun", ".dome/model-provider.ts"]');
    expect(source).toContain('await mkdir(join(vaultPath, "inbox", "raw"), { recursive: true });');
    expect(source).toContain('await mkdir(join(vaultPath, "wiki"), { recursive: true });');
  });
});
