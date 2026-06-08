import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandModelStepProvider } from "../../src/engine/command-model-provider";

function fakeProviderScript(): string {
  const dir = mkdtempSync(join(tmpdir(), "dome-step-"));
  const path = join(dir, "provider.ts");
  // Echoes a tool call back; asserts it received the step schema.
  writeFileSync(
    path,
    [
      "const req = JSON.parse(await Bun.stdin.text());",
      "if (req.schema !== 'dome.model-provider.step/v1') { console.error('bad schema'); process.exit(1); }",
      "process.stdout.write(JSON.stringify({",
      "  toolCalls: [{ id: 'c1', name: 'readPage', input: { path: 'a.md' } }],",
      "  costUsd: 0.001,",
      "}));",
    ].join("\n"),
  );
  return path;
}

describe("buildCommandModelStepProvider", () => {
  test("sends the step schema and parses tool calls", async () => {
    const provider = buildCommandModelStepProvider({
      kind: "command",
      command: ["bun", fakeProviderScript()],
    });
    const res = await provider({
      messages: [{ role: "user", content: "go" }],
      tools: [{ name: "readPage", description: "read", inputSchema: {} }],
      signal: new AbortController().signal,
    });
    expect(res.toolCalls?.[0]?.name).toBe("readPage");
    expect(res.costUsd).toBeCloseTo(0.001);
  });
});
