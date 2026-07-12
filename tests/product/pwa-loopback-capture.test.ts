import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHttp } from "../../src/cli/commands/http";
import { runInit } from "../../src/cli/commands/init";
import { runSync } from "../../src/cli/commands/sync";
import { getAdoptedRef } from "../../src/adopted-ref";
import { currentSha, log } from "../../src/git";

const roots: string[] = [];
const originalLog = console.log;
const originalError = console.error;

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P1 loopback paired capture journey", () => {
  test("pair → committed capture → idempotent retry → adopted", async () => {
    console.log = () => {};
    console.error = () => {};
    const vault = mkdtempSync(join(tmpdir(), "dome-pwa-p1-journey-"));
    roots.push(vault);
    expect(await runInit({ path: vault })).toBe(0);

    const controller = new AbortController();
    let baseUrl = "";
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const serving = runHttp({
      vault,
      pairCode: "local-code-123",
      port: 0,
      signal: controller.signal,
      onReady: (server) => {
        baseUrl = `http://${server.hostname}:${server.port}`;
        readyResolve();
      },
    });
    await ready;

    try {

    const pair = await fetch(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "local-code-123" }),
    });
    expect(pair.status).toBe(200);
    const cookie = (pair.headers.get("set-cookie") ?? "").split(";", 1)[0]!;
    expect(cookie).toStartWith("dome_pair=");

    const request = {
      text: "Remember the paired PWA journey",
      captureId: "pwa-e2e-1",
    };
    const first = await fetch(`${baseUrl}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    const receipt = await first.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schema: "dome.capture/v1",
      status: "captured",
      capture_id: "pwa-e2e-1",
      commit_status: "committed",
      adoption_status: "pending",
    });
    const path = String(receipt.path);
    expect(existsSync(join(vault, path))).toBe(true);
    expect(await readFile(join(vault, path), "utf8")).toContain('capture_id: "pwa-e2e-1"');

    const retry = await fetch(`${baseUrl}/capture`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(request),
    });
    expect(await retry.json()).toMatchObject({
      status: "duplicate",
      capture_id: "pwa-e2e-1",
      commit_status: "already-committed",
    });
    expect((await log({ path: vault, depth: 10 })).filter((entry) =>
      entry.commit.message.startsWith("capture:")
    ).length).toBe(1);

    expect(await runSync({ vault, quiet: true })).toBe(0);
    expect(await getAdoptedRef(vault, "main")).toBe(await currentSha(vault));

    } finally {
      controller.abort();
      expect(await serving).toBe(0);
    }
  }, 30_000);
});
