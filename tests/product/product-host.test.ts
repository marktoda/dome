import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { createAgentRuntime, type AgentRun } from "../../src/assistant/runtime";
import { runInit } from "../../src/cli/commands/init";
import { openDeviceAuthority } from "../../src/device-authority/device-authority";
import { add, commit } from "../../src/git";
import { exchangeDevicePairing } from "../../src/http/device-request-auth";
import { startProductHost, type ProductHost } from "../../src/product-host/product-host";
import { homeInstallationPaths, releaseRoot } from "../../src/product-host/home-installation";
import {
  inspectHomeLifecycleSuspension,
  withSupervisedHomeSuspended,
} from "../../src/product-host/home-lifecycle-suspension";
import { openRequestReceiptsDb } from "../../src/request-receipts/db";
import { createRequestReceipts } from "../../src/request-receipts/request-receipts";
import { vaultServiceSlug, type LaunchctlRunner } from "../../src/surface/service-probe";
import {
  engageOperationalWriterBarrier,
  releaseOperationalWriterBarrier,
} from "../../src/operational-state/writer-barrier";
import type { HomeArtifactManifest } from "../../src/product-host/home-artifact";

const roots: string[] = [];
const hosts: ProductHost[] = [];
const originalLog = console.log;
const originalError = console.error;

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("P3 Product Host", () => {
  test("owns one vault, reports readiness, releases ownership, and restarts", async () => {
    const vault = await initializedVault();
    const pairingCode = await mintPairingCode(vault, "Product test phone", [
      "capture", "converse", "read", "resolve",
    ]);
    const first = await startProductHost({
      vaultPath: vault,
      port: 0,
      pollIntervalMs: 25,
      externalOrigin: "http://localhost:5173",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    hosts.push(first.value);

    const auth = await pair(first.value.url, pairingCode);
    const externalPairing = await mintPairingCode(vault, "External origin phone", ["read"]);
    await pair(first.value.url, externalPairing, "http://localhost:5173");
    const ready = await fetch(`${first.value.url}/readyz`, { headers: { cookie: auth.cookie } });
    expect(ready.status).toBe(200);
    const readyDocument = await ready.json() as { readonly vault: { readonly id: string } };
    expect(readyDocument).toMatchObject({
      schema: "dome.product.readiness/v1",
      artifactId: "development",
      writesAdmitted: true,
      host: { state: "ready" },
      adoption: { state: "current" },
      vault: { name: vault.split("/").at(-1) },
      device: {
        name: "Product test phone",
        capabilities: ["capture", "converse", "read", "resolve"],
      },
    });
    expect((await fetch(`${first.value.url}/status`, { headers: { cookie: auth.cookie } })).status).toBe(410);

    const second = await startProductHost({
      vaultPath: vault,
      port: 0,
    });
    expect(second).toMatchObject({ ok: false, error: { kind: "busy" } });

    await first.value.close();
    hosts.splice(hosts.indexOf(first.value), 1);
    const restarted = await startProductHost({
      vaultPath: vault,
      port: 0,
      externalOrigin: "https://dome.tail.example",
    });
    expect(restarted.ok).toBe(true);
    if (restarted.ok) {
      hosts.push(restarted.value);
      expect((await restarted.value.readiness()).vault.id).toBe(readyDocument.vault.id);
      expect((await fetch(`${restarted.value.url}/readyz`, {
        headers: { cookie: auth.cookie },
      })).status).toBe(200);
    }
  }, 30_000);

  test("readiness resolves current local model state on every read", async () => {
    const vault = await initializedVault();
    let modelState: "ready" | "unconfigured" | "unreachable" = "unconfigured";
    let reads = 0;
    const started = await startProductHost({
      vaultPath: vault,
      port: 0,
      resolveModelState: async () => { reads += 1; return modelState; },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);
    expect((await started.value.readiness()).model.state).toBe("unconfigured");
    modelState = "ready";
    expect((await started.value.readiness()).model.state).toBe("ready");
    modelState = "unreachable";
    expect((await started.value.readiness()).model.state).toBe("unreachable");
    expect(reads).toBe(3);
  }, 30_000);

  test("Ask uses the Product Host's injected model step provider", async () => {
    const vault = await initializedVault();
    // Pair directly before the host opens the authority store. The /pair route
    // deliberately bypasses host scheduling, and this proof is about Ask's
    // provider seam rather than the separately-covered pairing adapter.
    const auth = await bootstrapBrowserAuth(vault, "Injected model browser", [
      "converse", "read",
    ]);
    let askCalls = 0;
    const started = await startProductHost({
      vaultPath: vault,
      port: 0,
      // This proof needs the Product Host scheduler and initial engine tick,
      // but not a second background tick competing with its one model turn.
      pollIntervalMs: 60_000,
      modelState: "ready",
      modelStepProvider: async (request) => {
        const last = request.messages.at(-1);
        if (last?.role !== "user" || last.content !== "Use the configured provider") {
          return { text: "no-op background response" };
        }
        askCalls += 1;
        return { text: "configured provider response" };
      },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);
    try {
      const created = await fetchTextWithin(
        "session creation",
        5_000,
        `${started.value.url}/sessions`,
        {
          method: "POST",
          headers: mutationHeaders(started.value.url, auth),
        },
      );
      expect(created.response.status).toBe(201);
      const sessionId = (JSON.parse(created.text) as { readonly sessionId: string }).sessionId;
      const turn = await fetchTextWithin(
        "injected-provider SSE turn",
        10_000,
        `${started.value.url}/sessions/${sessionId}/messages`,
        {
          method: "POST",
          headers: {
            ...mutationHeaders(started.value.url, auth),
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "Use the configured provider" }),
        },
        () => `provider calls observed: ${askCalls}`,
      );

      expect(turn.response.status).toBe(200);
      expect(turn.text).toContain('"text":"configured provider response"');
      expect(turn.text).toContain('"stopReason":"final"');
      expect(askCalls).toBe(1);
    } finally {
      // Bun does not cancel a timed-out async test body. Close here, while the
      // vault still exists, so a slow request cannot outlive fixture cleanup.
      await closeTrackedHost(started.value);
    }
  }, 60_000);

  test("an exact launchd child starts while its supervisor holds resuming Tx2", async () => {
    const vault = await initializedVault();
    const f = await installedResumeFixture(vault);
    let childStart: Promise<Awaited<ReturnType<typeof startProductHost>>> | null = null;
    let reportChild!: (result: Awaited<ReturnType<typeof startProductHost>>) => void;
    const childObserved = new Promise<Awaited<ReturnType<typeof startProductHost>>>((resolve) => {
      reportChild = resolve;
    });
    let childReported = false;
    const operationId = "product-host-live-resume";
    const parent = withSupervisedHomeSuspended({
      mode: "new",
      vaultPath: vault,
      purpose: "backup",
      operationId,
    }, async () => "snapshot", {
      platform: "darwin",
      uid: 501,
      applicationSupportDir: f.support,
      launchAgentsDir: f.agents,
      launchctl: f.launchctl,
      drainTimeoutMs: 50,
      readinessTimeoutMs: 5_000,
      readiness: async () => {
        childStart ??= startProductHost({
          vaultPath: vault,
          port: 0,
          launch: {
            kind: "normal",
            artifact: { id: f.artifactId, version: f.artifactVersion },
          },
        }, { homeStartup: f.startupDeps });
        const result = await childStart;
        if (!childReported) {
          childReported = true;
          if (result.ok) hosts.push(result.value);
          reportChild(result);
        }
        return result.ok;
      },
    });
    const resumed = await within(parent, 10_000);
    expect(resumed).toMatchObject({ kind: "ready", value: "snapshot" });
    const child = await childObserved;
    expect(child.ok).toBeTrue();
    expect(f.verification.calls).toBe(1);
    expect(await inspectHomeLifecycleSuspension(vault)).toEqual({ kind: "inactive" });
  }, 30_000);

  test("startup admission denies before Product Host durable stores mutate", async () => {
    const vault = await initializedVault();
    const protectedPaths = [
      join(vault, ".dome", "state", "request-receipts.db"),
      join(vault, ".dome", "state", "device-authority.db"),
      join(vault, ".dome", "state", "product-host-id"),
    ];
    const before = await fingerprintFiles(protectedPaths);
    const transactionId = "product-host-startup-closed";
    expect((await engageOperationalWriterBarrier({ vaultPath: vault, transactionId })).ok).toBeTrue();
    const denied = await startProductHost({ vaultPath: vault, port: 0 });
    expect(denied).toMatchObject({
      ok: false,
      error: { kind: "startup-failed" },
    });
    if (!denied.ok) expect(denied.error.message).toContain(transactionId);
    expect(await fingerprintFiles(protectedPaths)).toEqual(before);
    await releaseOperationalWriterBarrier({
      vaultPath: vault,
      transactionId,
      validateAndRemoveExternalEvidence: async () => {},
    });
  }, 30_000);

  test("startup denial preserves the exact suspension operation id", async () => {
    const vault = await initializedVault();
    const f = await installedResumeFixture(vault);
    const operationId = "product-host-resume-recovery";
    const suspended = await withSupervisedHomeSuspended({
      mode: "new",
      vaultPath: vault,
      purpose: "backup",
      operationId,
    }, async () => "snapshot", {
      platform: "darwin",
      uid: 501,
      applicationSupportDir: f.support,
      launchAgentsDir: f.agents,
      launchctl: f.launchctl,
      drainTimeoutMs: 20,
      readinessTimeoutMs: 1,
      readiness: async () => false,
    });
    expect(suspended.kind).toBe("failed");
    const denied = await startProductHost({
      vaultPath: vault,
      port: 0,
      launch: {
        kind: "normal",
        artifact: { id: f.artifactId, version: f.artifactVersion },
      },
    });
    expect(denied).toMatchObject({ ok: false, error: { kind: "startup-failed" } });
    if (!denied.ok) expect(denied.error.message).toContain(`suspension operation ${operationId}`);
  }, 30_000);

  test("a slow model turn does not block readiness, adopted reads, or capture", async () => {
    const vault = await initializedVault();
    const pairingCode = await mintPairingCode(vault, "Concurrent phone", [
      "capture", "converse", "read", "resolve",
    ]);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createAgentRuntime({
      createId: () => "slow-session",
      runTurn: (): AgentRun => ({
        text: (async function* () {
          yield "working";
          await blocked;
          yield "done";
        })(),
        finished: blocked.then(() => ({ citations: [], changes: [], stopReason: "final" as const })),
      }),
    });
    const started = await startProductHost({
      vaultPath: vault,
      port: 0,
      pollIntervalMs: 25,
      agentRuntime: runtime,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    hosts.push(started.value);
    const auth = await pair(started.value.url, pairingCode);

    const created = await fetch(`${started.value.url}/sessions`, {
      method: "POST",
      headers: mutationHeaders(started.value.url, auth),
    });
    expect(created.status).toBe(201);
    const turn = await fetch(`${started.value.url}/sessions/slow-session/messages`, {
      method: "POST",
      headers: {
        ...mutationHeaders(started.value.url, auth),
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "wait" }),
    });
    expect(turn.status).toBe(200);

    try {
      const [ready, today, doc, capture] = await within(Promise.all([
        fetch(`${started.value.url}/readyz`, { headers: { cookie: auth.cookie } }),
        fetch(`${started.value.url}/tasks`, { headers: { cookie: auth.cookie } }),
        fetch(`${started.value.url}/doc?path=wiki/host.md`, { headers: { cookie: auth.cookie } }),
        fetch(`${started.value.url}/capture`, {
          method: "POST",
          headers: {
            ...mutationHeaders(started.value.url, auth),
            "content-type": "application/json",
          },
          body: JSON.stringify({ text: "Concurrent owner capture", captureId: "p2-concurrent" }),
        }),
      ]), 2_000);
      expect(ready.status).toBe(200);
      expect(today.status).toBe(200);
      expect(doc.status).toBe(200);
      if (capture.status !== 200) {
        throw new Error(`capture returned ${capture.status}: ${await capture.text()}`);
      }
      const captureDocument = await capture.json() as { status: string; commit: string };
      expect(captureDocument).toMatchObject({
        status: "captured",
        adoption_status: "pending",
      });
      const receiptId = capture.headers.get("x-dome-receipt-id");
      const requestId = capture.headers.get("x-dome-request-id");
      expect(receiptId).not.toBeNull();
      expect(requestId).not.toBeNull();
      const receiptDb = await openRequestReceiptsDb({ path: join(vault, ".dome", "state", "request-receipts.db") });
      expect(receiptDb.ok).toBe(true);
      if (receiptDb.ok) {
        const receipts = createRequestReceipts(receiptDb.value.db);
        expect(receipts.list({ requestId: requestId! })).toEqual([
          expect.objectContaining({
            operationId: receiptId,
            requestId,
            operation: "capture",
            operationClass: "workspace-mutation",
            state: "succeeded",
            resultCode: "captured",
            commitOid: captureDocument.commit,
            transport: "cookie",
          }),
        ]);
        receipts.close();
      }
      await eventually(async () => {
        const readiness = await started.value.readiness();
        return readiness.adoption.state === "current" &&
          readiness.adoption.head === readiness.adoption.adopted;
      }, 3_000);
    } finally {
      release();
      await turn.text();
    }
  }, 30_000);

  test("restart persists and interrupts a prior host's admitted mutation", async () => {
    const vault = await initializedVault();
    const path = join(vault, ".dome", "state", "request-receipts.db");
    const opened = await openRequestReceiptsDb({ path });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const seeded = createRequestReceipts(opened.value.db, { createId: () => "prior-operation" });
    seeded.admit({
      requestId: "prior-request",
      actorId: "owner",
      deviceId: "prior-device",
      credentialId: "prior-credential",
      transport: "bearer",
      hostInstanceId: "prior-host",
      executor: "http",
      operation: "capture",
      operationClass: "workspace-mutation",
    });
    seeded.close();

    const started = await startProductHost({ vaultPath: vault, port: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await started.value.close();

    const reopened = await openRequestReceiptsDb({ path });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const receipts = createRequestReceipts(reopened.value.db);
    expect(receipts.list({ requestId: "prior-request" })).toEqual([
      expect.objectContaining({
        operationId: "prior-operation",
        state: "interrupted",
        resultCode: "host-restarted",
        adoptionState: "unknown",
        recoveryRequired: true,
      }),
    ]);
    receipts.close();
  }, 30_000);

  test("refuses startup when durable request receipts cannot open", async () => {
    const vault = await initializedVault();
    await writeFile(join(vault, ".dome", "state", "request-receipts.db"), "not sqlite", "utf8");
    const started = await startProductHost({ vaultPath: vault, port: 0 });
    expect(started).toMatchObject({
      ok: false,
      error: { kind: "startup-failed" },
    });
    if (!started.ok) expect(started.error.message).toContain("request receipts could not open");
  }, 30_000);
});

async function initializedVault(): Promise<string> {
  console.log = () => {};
  console.error = () => {};
  const vault = mkdtempSync(join(tmpdir(), "dome-product-host-"));
  roots.push(vault);
  expect(await runInit({ path: vault })).toBe(0);
  await mkdir(join(vault, "wiki"), { recursive: true });
  await writeFile(join(vault, "wiki", "host.md"), "# Product Host\n", "utf8");
  await add(vault, "wiki/host.md");
  await commit({ path: vault, message: "seed product host fixture" });
  return vault;
}

async function installedResumeFixture(vaultPath: string) {
  const vault = await realpath(vaultPath);
  const root = dirname(vault);
  const support = join(root, `${basename(vault)}-Home-Support`);
  const agents = join(root, `${basename(vault)}-LaunchAgents`);
  roots.push(support, agents);
  const paths = homeInstallationPaths(vault, { applicationSupportDir: support });
  const artifactId = "a".repeat(64);
  const artifactVersion = "1.0.0";
  const release = releaseRoot(paths, artifactId);
  const runtime = join(release, "runtime", "bun");
  const entrypoint = join(release, "app", "bin", "dome");
  await mkdir(paths.installations, { recursive: true });
  await mkdir(dirname(runtime), { recursive: true });
  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(agents, { recursive: true });
  await writeFile(runtime, "test Bun runtime\n", { mode: 0o700 });
  await writeFile(entrypoint, "test Dome entrypoint\n", { mode: 0o700 });
  await writeFile(paths.record, `${JSON.stringify({
    schema: "dome.home.installation/v1",
    vault,
    artifact: { id: artifactId, version: artifactVersion },
    environment: [],
  })}\n`, { mode: 0o600 });
  const label = `com.dome.home.${vaultServiceSlug(vault)}`;
  const target = `gui/501/${label}`;
  const plist = join(agents, `${label}.plist`);
  await writeFile(plist, "strict plist bytes\n", { mode: 0o600 });
  const loaded = new Set([target]);
  const launchctl: LaunchctlRunner = async (args) => {
    const candidate = args.at(-1) ?? "";
    if (args[0] === "print") return launchctlOutcome(loaded.has(candidate) ? 0 : 113);
    if (args[0] === "bootout") { loaded.delete(candidate); return launchctlOutcome(0); }
    if (args[0] === "bootstrap") {
      const bootLabel = basename(args[2] ?? "").replace(/\.plist$/, "");
      loaded.add(`${args[1]}/${bootLabel}`);
      return launchctlOutcome(0);
    }
    if (args[0] === "kickstart") { loaded.add(candidate); return launchctlOutcome(0); }
    return launchctlOutcome(0);
  };
  const verification = { calls: 0 };
  const verifyArtifact = async (candidate: string) => {
    verification.calls += 1;
    if (candidate !== release) throw new Error("unexpected managed release path");
    return legacyManifest(artifactId, artifactVersion, "test Bun runtime\n", "0700");
  };
  return {
    support,
    agents,
    artifactId,
    artifactVersion,
    launchctl,
    verification,
    startupDeps: {
      applicationSupportDir: support,
      launchAgentsDir: agents,
      invokingRuntimePath: runtime,
      invokingEntrypointPath: entrypoint,
      verifyArtifact,
    },
  };
}

function legacyManifest(
  artifactId: string,
  version: string,
  runtimeBytes: string,
  runtimeMode: string,
): HomeArtifactManifest {
  const runtimeSha256 = createHash("sha256").update(runtimeBytes).digest("hex");
  return {
    schema: "dome.home-artifact/v1",
    product: { name: "Dome Home", version },
    target: { os: "darwin", arch: "arm64" },
    build: { gitCommit: "fixture" },
    artifact: { id: artifactId },
    runtime: {
      name: "bun",
      version: "1.2.13",
      sourceUrl: "https://example.invalid/bun.zip",
      archiveSha256: "0".repeat(64),
      sha256: runtimeSha256,
    },
    tools: [],
    entrypoint: "bin/dome",
    pwa: "app/pwa/dist",
    distribution: { signed: false, notarized: false, upgradeSupported: false },
    entries: [{
      type: "file",
      path: "runtime/bun",
      bytes: Buffer.byteLength(runtimeBytes),
      sha256: runtimeSha256,
      mode: runtimeMode,
    }],
  };
}

async function fingerprintFiles(paths: ReadonlyArray<string>): Promise<ReadonlyArray<string>> {
  return Promise.all(paths.map(async (path) => {
    try {
      const info = await lstat(path);
      const mode = (info.mode & 0o777).toString(8);
      if (!info.isFile() || info.isSymbolicLink()) {
        return `other\0${path}\0${mode}`;
      }
      return `file\0${path}\0${mode}\0${Buffer.from(await readFile(path)).toString("base64")}`;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return `missing\0${path}`;
      }
      throw error;
    }
  }));
}

function launchctlOutcome(exitCode: number) { return { exitCode, stdout: "", stderr: "" }; }

type BrowserAuth = { readonly cookie: string; readonly csrf: string };

async function pair(
  baseUrl: string,
  code: string,
  origin: string = baseUrl,
): Promise<BrowserAuth> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ code }),
  });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0] ?? "");
  const csrfCookie = cookies.find((value) => value.startsWith("dome_csrf="));
  return {
    cookie: cookies.join("; "),
    csrf: decodeURIComponent(csrfCookie?.slice("dome_csrf=".length) ?? ""),
  };
}

function mutationHeaders(baseUrl: string, auth: BrowserAuth): Record<string, string> {
  return { cookie: auth.cookie, origin: baseUrl, "x-dome-csrf": auth.csrf };
}

async function fetchTextWithin(
  operation: string,
  milliseconds: number,
  url: string,
  init: RequestInit,
  diagnostic?: () => string,
): Promise<{ readonly response: Response; readonly text: string }> {
  const signal = AbortSignal.timeout(milliseconds);
  try {
    const response = await fetch(url, { ...init, signal });
    return { response, text: await response.text() };
  } catch (error) {
    if (!signal.aborted) throw error;
    const detail = diagnostic?.();
    throw new Error(
      `${operation} exceeded ${milliseconds}ms${detail === undefined ? "" : ` (${detail})`}`,
      { cause: error },
    );
  }
}

async function closeTrackedHost(host: ProductHost): Promise<void> {
  await host.close();
  const index = hosts.indexOf(host);
  if (index >= 0) hosts.splice(index, 1);
}

async function bootstrapBrowserAuth(
  vault: string,
  deviceName: string,
  capabilities: Array<"capture" | "converse" | "read" | "resolve">,
): Promise<BrowserAuth> {
  const opened = await openDeviceAuthority({
    path: join(vault, ".dome", "state", "device-authority.db"),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("device authority did not open");
  try {
    const minted = opened.value.authority.mintPairingGrant({ deviceName, capabilities });
    expect(minted.kind).toBe("minted");
    if (minted.kind !== "minted") throw new Error("pairing code did not mint");
    const exchanged = exchangeDevicePairing(opened.value.authority, {
      pairingCode: minted.pairingCode,
      requestOrigin: "http://127.0.0.1",
    });
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) throw new Error(`pairing exchange failed: ${exchanged.failure.code}`);
    return {
      cookie: exchanged.setCookies
        .map((value) => value.split(";", 1)[0] ?? "")
        .join("; "),
      csrf: exchanged.csrfToken,
    };
  } finally {
    opened.value.authority.close();
  }
}

async function mintPairingCode(
  vault: string,
  deviceName: string,
  capabilities: Array<"capture" | "converse" | "read" | "resolve">,
): Promise<string> {
  const opened = await openDeviceAuthority({
    path: join(vault, ".dome", "state", "device-authority.db"),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error("device authority did not open");
  const minted = opened.value.authority.mintPairingGrant({ deviceName, capabilities });
  opened.value.authority.close();
  expect(minted.kind).toBe("minted");
  if (minted.kind !== "minted") throw new Error("pairing code did not mint");
  return minted.pairingCode;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`operation exceeded ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function eventually(check: () => Promise<boolean>, milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(25);
  }
  throw new Error(`condition was not met within ${milliseconds}ms`);
}
