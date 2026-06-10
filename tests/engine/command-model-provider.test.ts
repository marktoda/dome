import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCommandModelProvider } from "../../src/engine/host/command-model-provider";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("buildCommandModelProvider", () => {
  test("sends typed request JSON on stdin and reads response JSON from stdout", async () => {
    const providerPath = writeProvider(`
const request = JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify({
  text: JSON.stringify({
    schema: request.schema,
    prompt: request.prompt,
    model: request.model,
    temperature: request.temperature,
  }),
  model: request.model,
  costUsd: 0.25,
}));
`);
    const provider = buildCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });

    const response = await provider({
      prompt: "Summarize this",
      model: "test-model",
      temperature: 0.2,
      signal: new AbortController().signal,
    });

    expect(response.model).toBe("test-model");
    expect(response.costUsd).toBe(0.25);
    expect(JSON.parse(response.text)).toEqual({
      schema: "dome.model-provider.request/v1",
      prompt: "Summarize this",
      model: "test-model",
      temperature: 0.2,
    });
  });

  test("surfaces nonzero command failures with stderr", async () => {
    const providerPath = writeProvider(`
console.error("provider unavailable");
process.exit(17);
`);
    const provider = buildCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });

    await expect(
      provider({
        prompt: "Summarize this",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("provider unavailable");
  });

  test("validates response shape before returning", async () => {
    const providerPath = writeProvider(`
console.log(JSON.stringify({ text: 42 }));
`);
    const provider = buildCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });

    await expect(
      provider({
        prompt: "Summarize this",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      code: "model.invoke.provider-failed",
      retryable: true,
    });
  });
});

function writeProvider(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "dome-command-provider-"));
  roots.push(root);
  const path = join(root, "provider.js");
  writeFileSync(path, source, "utf8");
  return path;
}
