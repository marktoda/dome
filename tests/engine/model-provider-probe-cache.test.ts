import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readModelProviderProbeCache,
  writeModelProviderProbeCache,
} from "../../src/engine/host/model-provider-probe-cache";

describe("model-provider probe cache compatibility", () => {
  test("reads legacy v1 probe-unsupported results without exitCode", async () => {
    const vault = await mkdtemp(join(tmpdir(), "dome-probe-cache-"));
    try {
      const state = join(vault, ".dome", "state");
      await mkdir(state, { recursive: true });
      await writeFile(join(state, "model-provider-probe.json"), JSON.stringify({
        schema: "dome.model-provider.probe-cache/v1",
        command: ["bun", ".dome/model-provider.ts"],
        probedAt: "2026-07-14T00:00:00.000Z",
        result: { status: "probe-unsupported", detail: "legacy provider exited 1" },
      }));

      expect(readModelProviderProbeCache(vault)?.result).toEqual({
        status: "probe-unsupported",
        detail: "legacy provider exited 1",
      });
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  test("round-trips the numeric exit code for current probe-unsupported results", async () => {
    const vault = await mkdtemp(join(tmpdir(), "dome-probe-cache-"));
    try {
      writeModelProviderProbeCache(vault, {
        command: ["helper", "run-model-provider", "/vault"],
        probedAt: new Date("2026-07-14T00:00:00.000Z"),
        result: { status: "probe-unsupported", exitCode: 44, detail: "credential missing" },
      });

      expect(readModelProviderProbeCache(vault)?.result).toEqual({
        status: "probe-unsupported",
        exitCode: 44,
        detail: "credential missing",
      });
      expect(await readFile(join(vault, ".dome", "state", "model-provider-probe.json"), "utf8"))
        .toContain('"exitCode": 44');
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });
});
