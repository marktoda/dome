// `dome http` — runHttp handler tests (shared setup lives in ./fixture.ts).
//
// The validation paths (token resolution, port validation, vault
// preconditions) return exit codes without ever binding a listener. The
// listen path uses the test-only seams on RunHttpOptions: `onReady` to
// discover the ephemeral port and `signal` to stop the server (production
// waits for SIGINT/SIGTERM instead).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runHttp } from "../../../src/cli/commands/http";
import { EX_USAGE } from "../../../src/cli/exit-codes";

import {
  captured,
  fixtures,
  installConsoleCapture,
  installFixtureCleanup,
  makeFixture,
  writeDoctorConfig,
  type Fixture,
} from "./fixture";

installConsoleCapture();
installFixtureCleanup();

// runHttp reads DOME_HTTP_TOKEN; isolate every test from the real env.
let savedEnvToken: string | undefined;
let savedPairCode: string | undefined;

beforeEach(() => {
  savedEnvToken = process.env["DOME_HTTP_TOKEN"];
  savedPairCode = process.env["DOME_PAIR_CODE"];
  delete process.env["DOME_HTTP_TOKEN"];
  delete process.env["DOME_PAIR_CODE"];
});

afterEach(() => {
  if (savedEnvToken === undefined) delete process.env["DOME_HTTP_TOKEN"];
  else process.env["DOME_HTTP_TOKEN"] = savedEnvToken;
  if (savedPairCode === undefined) delete process.env["DOME_PAIR_CODE"];
  else process.env["DOME_PAIR_CODE"] = savedPairCode;
});

/** A fixture vault that passes runHttp's vault preconditions. */
async function makeHttpVault(): Promise<Fixture> {
  const f = await makeFixture();
  fixtures.push(f);
  await writeDoctorConfig(f);
  return f;
}

// ----- Vault preconditions -----------------------------------------------------

describe("runHttp vault preconditions", () => {
  test("a directory without a git repository is EX_USAGE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dome-http-novault-"));
    try {
      expect(await runHttp({ vault: dir, token: "t" })).toBe(EX_USAGE);
      expect(captured.err.join("\n")).toContain("missing git repository");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a git repo without .dome/config.yaml is EX_USAGE", async () => {
    const f = await makeFixture();
    fixtures.push(f);
    expect(await runHttp({ vault: f.vaultPath, token: "t" })).toBe(EX_USAGE);
    expect(captured.err.join("\n")).toContain("missing .dome/config.yaml");
  });
});

// ----- Token resolution -----------------------------------------------------------

describe("runHttp token resolution", () => {
  test("no flag and no env is EX_USAGE with the documented message", async () => {
    const f = await makeHttpVault();
    expect(await runHttp({ vault: f.vaultPath })).toBe(EX_USAGE);
    expect(captured.err.join("\n")).toContain(
      "a bearer token or loopback pairing code is required",
    );
  });

  test("a whitespace-only token is EX_USAGE", async () => {
    const f = await makeHttpVault();
    expect(await runHttp({ vault: f.vaultPath, token: "   " })).toBe(EX_USAGE);
  });

  test("pairing codes are loopback-only and have a minimum length", async () => {
    const f = await makeHttpVault();
    expect(await runHttp({ vault: f.vaultPath, pairCode: "short" })).toBe(EX_USAGE);
    expect(await runHttp({
      vault: f.vaultPath,
      pairCode: "local-code-123",
      host: "0.0.0.0",
    })).toBe(EX_USAGE);
    expect(captured.err.join("\n")).toContain("remote exposure waits for hardened device auth");
  });
});

// ----- Port validation -------------------------------------------------------------

describe("runHttp port validation", () => {
  test("non-integer and out-of-range ports are EX_USAGE", async () => {
    const f = await makeHttpVault();
    expect(await runHttp({ vault: f.vaultPath, token: "t", port: "banana" })).toBe(
      EX_USAGE,
    );
    expect(captured.err.join("\n")).toContain(
      "--port must be an integer in [0, 65535]",
    );
    expect(await runHttp({ vault: f.vaultPath, token: "t", port: 70_000 })).toBe(
      EX_USAGE,
    );
    expect(await runHttp({ vault: f.vaultPath, token: "t", port: 3.5 })).toBe(
      EX_USAGE,
    );
    expect(await runHttp({ vault: f.vaultPath, token: "t", port: -1 })).toBe(
      EX_USAGE,
    );
  });
});

// ----- The listen path ----------------------------------------------------------------

describe("runHttp listen path", () => {
  test("loopback pairing can host the browser without a bearer token", async () => {
    const f = await makeHttpVault();
    const controller = new AbortController();
    let baseUrl = "";
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    const exitCode = runHttp({
      vault: f.vaultPath,
      pairCode: "local-code-123",
      port: 0,
      signal: controller.signal,
      onReady: (server) => {
        baseUrl = `http://${server.hostname}:${server.port}`;
        readyResolve();
      },
    });
    await ready;
    const paired = await fetch(`${baseUrl}/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "local-code-123" }),
    });
    expect(paired.status).toBe(200);
    expect(paired.headers.get("set-cookie")).toContain("HttpOnly");
    controller.abort();
    expect(await exitCode).toBe(0);
  });

  test("serves over real HTTP, flag token beats env, stops cleanly on abort", async () => {
    const f = await makeHttpVault();
    process.env["DOME_HTTP_TOKEN"] = "env-token";

    const controller = new AbortController();
    let baseUrl: string | null = null;
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const exitCode = runHttp({
      vault: f.vaultPath,
      token: "flag-token",
      port: 0,
      signal: controller.signal,
      onReady: (server) => {
        baseUrl = `http://${server.hostname}:${server.port}`;
        readyResolve();
      },
    });

    await ready;
    expect(baseUrl).not.toBeNull();

    // The flag token authorizes…
    const ok = await fetch(`${baseUrl}/`, {
      headers: { authorization: "Bearer flag-token" },
    });
    expect(ok.status).toBe(200);
    const identity = (await ok.json()) as Record<string, unknown>;
    expect(identity.schema).toBe("dome.http/v1");
    expect(identity.vault).toBe(f.vaultPath);

    // …the env token does not: the flag wins.
    const env = await fetch(`${baseUrl}/`, {
      headers: { authorization: "Bearer env-token" },
    });
    expect(env.status).toBe(401);

    controller.abort();
    expect(await exitCode).toBe(0);
  });

  test("falls back to the env token when no flag is passed", async () => {
    const f = await makeHttpVault();
    process.env["DOME_HTTP_TOKEN"] = "env-only-token";

    const controller = new AbortController();
    let baseUrl: string | null = null;
    let readyResolve: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve;
    });

    const exitCode = runHttp({
      vault: f.vaultPath,
      port: 0,
      signal: controller.signal,
      onReady: (server) => {
        baseUrl = `http://${server.hostname}:${server.port}`;
        readyResolve();
      },
    });

    await ready;
    const ok = await fetch(`${baseUrl}/`, {
      headers: { authorization: "Bearer env-only-token" },
    });
    expect(ok.status).toBe(200);

    controller.abort();
    expect(await exitCode).toBe(0);
  });
});
