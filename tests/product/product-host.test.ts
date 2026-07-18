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
import {
  cleanupOwnedProductFixtures,
  closeTrackedProductFixture,
} from "./support/owned-fixture-cleanup";
import {
  fetchBodiesWithin,
  fetchResponseWithin,
  fetchTextWithin,
  pollJsonWithin,
  readControlledResponseText,
  type ControlledResponse,
} from "./support/bounded-http";

const roots: string[] = [];
const hosts: ProductHost[] = [];
const originalLog = console.log;
const originalError = console.error;

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  await cleanupOwnedProductFixtures(hosts, roots, {
    removeRoot: (root) => rm(root, { recursive: true, force: true }),
  });
});

describe("P3 Product Host", () => {
  test("owns one vault, reports readiness, releases ownership, and restarts", async () => {
    const vault = await initializedVault();
    const pairingCode = await mintPairingCode(vault, "Product test phone", [
      "capture", "converse", "read", "resolve",
    ]);
    const first = await startTrackedProductHost({
      vaultPath: vault,
      port: 0,
      pollIntervalMs: 25,
      externalOrigin: "http://localhost:5173",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const auth = await pair(first.value.url, pairingCode);
    const externalPairing = await mintPairingCode(vault, "External origin phone", ["read"]);
    await pair(first.value.url, externalPairing, "http://localhost:5173");
    const readyDocument = await readProductReadiness(first.value.url, auth);
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
    expect((await fetchTextWithin(
      "retired status route",
      5_000,
      `${first.value.url}/status`,
      { headers: { cookie: auth.cookie } },
    )).response.status).toBe(410);

    const second = await startTrackedProductHost({
      vaultPath: vault,
      port: 0,
    });
    expect(second).toMatchObject({ ok: false, error: { kind: "busy" } });

    await closeTrackedProductFixture(first.value, hosts);
    const restarted = await startTrackedProductHost({
      vaultPath: vault,
      port: 0,
      externalOrigin: "https://dome.tail.example",
    });
    expect(restarted.ok).toBe(true);
    if (restarted.ok) {
      const restartedReadiness = await readProductReadiness(restarted.value.url, auth);
      expect(restartedReadiness.vault.id).toBe(readyDocument.vault.id);
    }
  }, 30_000);

  test("readiness resolves current local model state on every read", async () => {
    const vault = await initializedVault();
    const auth = await bootstrapBrowserAuth(vault, "Readiness browser", ["read"]);
    let modelState: "ready" | "unconfigured" | "unreachable" = "unconfigured";
    let reads = 0;
    const started = await startTrackedProductHost({
      vaultPath: vault,
      port: 0,
      resolveModelState: async () => { reads += 1; return modelState; },
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect((await readProductReadiness(started.value.url, auth)).model.state).toBe("unconfigured");
    modelState = "ready";
    expect((await readProductReadiness(started.value.url, auth)).model.state).toBe("ready");
    modelState = "unreachable";
    expect((await readProductReadiness(started.value.url, auth)).model.state).toBe("unreachable");
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
    const started = await startTrackedProductHost({
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
      await closeTrackedProductFixture(started.value, hosts);
    }
  }, 60_000);

  test("an exact launchd child starts while its supervisor holds resuming Tx2", async () => {
    const vault = await initializedVault();
    const f = await installedResumeFixture(vault);
    let childStart: Promise<Awaited<ReturnType<typeof startTrackedProductHost>>> | null = null;
    let reportChild!: (result: Awaited<ReturnType<typeof startTrackedProductHost>>) => void;
    const childObserved = new Promise<Awaited<ReturnType<typeof startTrackedProductHost>>>((resolve) => {
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
        childStart ??= startTrackedProductHost({
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
    const denied = await startTrackedProductHost({ vaultPath: vault, port: 0 });
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
    const denied = await startTrackedProductHost({
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
    // Pair before the host owns the authority store. Pairing concurrency is
    // covered by the device-authority tests; this proof is about independent
    // Product Host operation classes while generation remains in flight.
    const auth = await bootstrapBrowserAuth(vault, "Concurrent phone", [
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
    const started = await startTrackedProductHost({
      vaultPath: vault,
      port: 0,
      pollIntervalMs: 25,
      agentRuntime: runtime,
    });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    let turn: ControlledResponse | null = null;
    try {
      const created = await fetchTextWithin(
        "slow-turn session creation",
        5_000,
        `${started.value.url}/sessions`,
        {
          method: "POST",
          headers: mutationHeaders(started.value.url, auth),
        },
      );
      expect(created.response.status).toBe(201);
      turn = await fetchResponseWithin(
        "slow-turn SSE headers",
        5_000,
        `${started.value.url}/sessions/slow-session/messages`,
        {
          method: "POST",
          headers: {
            ...mutationHeaders(started.value.url, auth),
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: "wait" }),
        },
      );
      expect(turn.response.status).toBe(200);

      const [ready, today, doc, capture] = await fetchBodiesWithin(
        "concurrent Product Host operations",
        2_000,
        [{
          url: `${started.value.url}/readyz`,
          init: { headers: { cookie: auth.cookie } },
        }, {
          url: `${started.value.url}/tasks`,
          init: { headers: { cookie: auth.cookie } },
        }, {
          url: `${started.value.url}/doc?path=wiki/host.md`,
          init: { headers: { cookie: auth.cookie } },
        }, {
          url: `${started.value.url}/capture`,
          init: {
            method: "POST",
            headers: {
              ...mutationHeaders(started.value.url, auth),
              "content-type": "application/json",
            },
            body: JSON.stringify({
              text: "Concurrent owner capture",
              captureId: "p2-concurrent",
            }),
          },
        }],
      );
      expect(ready.response.status).toBe(200);
      expect(today.response.status).toBe(200);
      expect(doc.response.status).toBe(200);
      if (capture.response.status !== 200) {
        throw new Error(`capture returned ${capture.response.status}: ${capture.text}`);
      }
      const captureDocument = JSON.parse(capture.text) as { status: string; commit: string };
      expect(captureDocument).toMatchObject({
        status: "captured",
        adoption_status: "pending",
      });
      const receiptId = capture.response.headers.get("x-dome-receipt-id");
      const requestId = capture.response.headers.get("x-dome-request-id");
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
      await pollJsonWithin<{
        adoption: { state: string; head: string | null; adopted: string | null };
      }>({
        operation: "post-capture readiness",
        totalMs: 3_000,
        requestMs: 500,
        url: `${started.value.url}/readyz`,
        init: { headers: { cookie: auth.cookie } },
        accept: (readiness) => {
          return readiness.adoption.state === "current" &&
            readiness.adoption.head === readiness.adoption.adopted;
        },
      });
    } finally {
      // Bun does not cancel an async test body when its test deadline fires.
      // Always unblock and drain the deliberately cancellation-resistant model
      // fixture, then close the host while its SQLite files still exist.
      release();
      try {
        if (turn !== null) await readControlledResponseText(turn, 5_000, "slow-turn SSE body");
      } finally {
        turn?.abort();
        await closeTrackedProductFixture(started.value, hosts);
      }
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

    const started = await startTrackedProductHost({ vaultPath: vault, port: 0 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await closeTrackedProductFixture(started.value, hosts);

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
    const started = await startTrackedProductHost({ vaultPath: vault, port: 0 });
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
type ProductReadiness = Awaited<ReturnType<ProductHost["readiness"]>>;

async function pair(
  baseUrl: string,
  code: string,
  origin: string = baseUrl,
): Promise<BrowserAuth> {
  const response = await fetchTextWithin(
    "browser pairing",
    5_000,
    `${baseUrl}/pair`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ code }),
    },
  );
  expect(response.response.status).toBe(200);
  const cookies = response.response.headers.getSetCookie()
    .map((value) => value.split(";", 1)[0] ?? "");
  const csrfCookie = cookies.find((value) => value.startsWith("dome_csrf="));
  return {
    cookie: cookies.join("; "),
    csrf: decodeURIComponent(csrfCookie?.slice("dome_csrf=".length) ?? ""),
  };
}

async function readProductReadiness(
  baseUrl: string,
  auth: BrowserAuth,
): Promise<ProductReadiness> {
  const ready = await fetchTextWithin(
    "Product Host readiness",
    5_000,
    `${baseUrl}/readyz`,
    { headers: { cookie: auth.cookie } },
  );
  expect(ready.response.status).toBe(200);
  return JSON.parse(ready.text) as ProductReadiness;
}

async function startTrackedProductHost(
  options: Parameters<typeof startProductHost>[0],
  deps?: Parameters<typeof startProductHost>[1],
): ReturnType<typeof startProductHost> {
  const result = await startProductHost(options, deps);
  if (result.ok) hosts.push(result.value);
  return result;
}

function mutationHeaders(baseUrl: string, auth: BrowserAuth): Record<string, string> {
  return { cookie: auth.cookie, origin: baseUrl, "x-dome-csrf": auth.csrf };
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
