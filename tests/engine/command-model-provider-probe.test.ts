// Probe coverage for the command model provider boundary.
//
// `probeCommandModelProvider` sends a `dome.model-provider.probe/v1`
// envelope to the configured command and classifies the outcome per
// docs/wiki/specs/cli.md §"dome doctor": responsive / probe-unsupported /
// spawn-failed / invalid-response / timed-out. It never throws and never
// sends a request/step envelope.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeCommandModelProvider } from "../../src/engine/command-model-provider";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("probeCommandModelProvider", () => {
  test("responsive: valid probe answer with provider/keyPresent/defaultModel", async () => {
    const providerPath = writeProvider(`
const request = JSON.parse(await Bun.stdin.text());
if (request.schema !== "dome.model-provider.probe/v1") {
  console.error("expected a probe envelope, got: " + String(request.schema));
  process.exit(2);
}
console.log(JSON.stringify({
  schema: "dome.model-provider.probe/v1",
  ok: true,
  provider: "anthropic",
  keyPresent: true,
  defaultModel: "claude-sonnet-4-6",
}));
`);
    const result = await probeCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });
    expect(result).toEqual({
      status: "responsive",
      provider: "anthropic",
      keyPresent: true,
      defaultModel: "claude-sonnet-4-6",
    });
  });

  test("responsive: keyPresent false flows through; env opt controls the child env", async () => {
    const providerPath = writeProvider(`
const key = process.env.DOME_TEST_PROBE_KEY;
console.log(JSON.stringify({
  schema: "dome.model-provider.probe/v1",
  ok: true,
  keyPresent: key !== undefined && key.length > 0,
}));
`);
    const config = {
      kind: "command" as const,
      command: [process.execPath, providerPath],
    };

    const withoutKey = await probeCommandModelProvider(config, {
      env: { ...process.env, DOME_TEST_PROBE_KEY: undefined },
    });
    expect(withoutKey).toEqual({ status: "responsive", keyPresent: false });

    const withKey = await probeCommandModelProvider(config, {
      env: { ...process.env, DOME_TEST_PROBE_KEY: "sk-test" },
    });
    expect(withKey).toEqual({ status: "responsive", keyPresent: true });
  });

  test("probe-unsupported: command runs, reads the envelope, exits non-zero", async () => {
    // The shape of a pre-probe hand-written provider: unknown schema → error.
    const providerPath = writeProvider(`
await Bun.stdin.text();
console.error("unsupported Dome model provider request schema");
process.exit(1);
`);
    const result = await probeCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });
    expect(result.status).toBe("probe-unsupported");
    if (result.status === "probe-unsupported") {
      expect(result.detail).toContain("exited 1");
      expect(result.detail).toContain("unsupported Dome model provider");
    }
  });

  test("invalid-response: exit 0 with non-JSON stdout", async () => {
    const providerPath = writeProvider(`
console.log("definitely not json");
`);
    const result = await probeCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });
    expect(result.status).toBe("invalid-response");
    if (result.status === "invalid-response") {
      expect(result.detail).toContain("not valid JSON");
    }
  });

  test("invalid-response: exit 0 with JSON that misses the probe schema", async () => {
    const providerPath = writeProvider(`
console.log(JSON.stringify({ ok: true }));
`);
    const result = await probeCommandModelProvider({
      kind: "command",
      command: [process.execPath, providerPath],
    });
    expect(result.status).toBe("invalid-response");
    if (result.status === "invalid-response") {
      expect(result.detail).toContain("dome.model-provider.probe/v1");
    }
  });

  test("spawn-failed: nonexistent command", async () => {
    const result = await probeCommandModelProvider({
      kind: "command",
      command: ["/nonexistent/dome-test-model-provider"],
    });
    expect(result.status).toBe("spawn-failed");
  });

  test("timed-out: command that never answers is killed at the deadline", async () => {
    const providerPath = writeProvider(`
await Bun.stdin.text();
setTimeout(() => {}, 60_000); // keep the event loop alive, never answer
`);
    const result = await probeCommandModelProvider(
      {
        kind: "command",
        command: [process.execPath, providerPath],
      },
      { timeoutMs: 250 },
    );
    expect(result.status).toBe("timed-out");
    if (result.status === "timed-out") {
      expect(result.detail).toContain("250ms");
    }
  });

  test("timed-out: a SIGTERM-trapping command is SIGKILLed instead of hanging the probe", async () => {
    // A provider that ignores SIGTERM and never answers. Without the
    // SIGKILL escalation, `await proc.exited` would never resolve and
    // `dome doctor` would hang forever.
    const providerPath = writeProvider(`
process.on("SIGTERM", () => {});
await Bun.stdin.text();
setInterval(() => {}, 1_000); // keep alive indefinitely
`);
    const started = Date.now();
    const result = await probeCommandModelProvider(
      {
        kind: "command",
        command: [process.execPath, providerPath],
      },
      { timeoutMs: 250 },
    );
    expect(result.status).toBe("timed-out");
    // 250ms deadline + 500ms SIGKILL grace, with slack for a slow runner —
    // the load-bearing assertion is that this resolves at all, promptly.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

function writeProvider(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "dome-provider-probe-"));
  roots.push(root);
  const path = join(root, "provider.js");
  writeFileSync(path, source, "utf8");
  return path;
}
