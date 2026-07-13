import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proveHomeUpgradeCandidate } from "../../src/product-host/home-upgrade-candidate";

const roots: string[] = [];
const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("managed Home upgrade candidate", () => {
  test("launches the pinned child, proves exact probation, terminates, and drains", async () => {
    const fixture = await candidateFixture();
    const port = await availablePort();
    const proof = await proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      transactionId: TRANSACTION_ID,
      candidate: fixture.candidate,
    }, { port, readinessTimeoutMs: 5_000, drainTimeoutMs: 2_000, verifyCandidate: async () => {} });
    expect(proof).toMatchObject({
      schema: "dome.home-upgrade-probation-proof/v1",
      transactionId: TRANSACTION_ID,
      readinessSchema: "dome.product.readiness/v1",
      hostState: "probation",
      artifactId: "c".repeat(64),
      productVersion: "2.0.0",
      vaultId: "vault-proof-id",
      writesAdmitted: false,
    });
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  test("rejects dishonest readiness and still terminates the child", async () => {
    const fixture = await candidateFixture({ writesAdmitted: true });
    const port = await availablePort();
    await expect(proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      transactionId: TRANSACTION_ID,
      candidate: fixture.candidate,
    }, { port, readinessTimeoutMs: 2_000, drainTimeoutMs: 2_000, verifyCandidate: async () => {} })).rejects.toThrow(
      "does not match exact probation identity",
    );
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  test("uses only the pinned runtime, entrypoint, and hidden probation argv", async () => {
    const fixture = await candidateFixture();
    let command: ReadonlyArray<string> = [];
    let settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { settle = resolve; });
    const proof = await proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      transactionId: TRANSACTION_ID,
      candidate: fixture.candidate,
    }, {
      port: 45678,
      verifyCandidate: async () => {},
      spawn: (argv) => {
        command = argv;
        return { exited, kill: () => settle(0) };
      },
      fetch: async (url) => {
        if (url.endsWith("/healthz")) throw new Error("drained");
        return Response.json(readiness());
      },
    });
    expect(command).toEqual([
      join(fixture.candidate.releasePath, "runtime", "bun"),
      join(fixture.candidate.releasePath, "app", "bin", "dome"),
      "home", "--upgrade-probation", "--vault", fixture.vault,
      "--host", "127.0.0.1", "--port", "45678", "--static-dir",
      join(fixture.candidate.releasePath, "app", "pwa", "dist"),
    ]);
    expect(proof.hostState).toBe("probation");
  });

  test("fails closed on early exit and readiness timeout", async () => {
    const fixture = await candidateFixture();
    await expect(proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      transactionId: TRANSACTION_ID,
      candidate: fixture.candidate,
    }, {
      port: 45679,
      verifyCandidate: async () => {},
      spawn: () => ({ exited: Promise.resolve(17), kill: () => {} }),
      fetch: async () => { throw new Error("not listening"); },
      readinessTimeoutMs: 20,
    })).rejects.toThrow("exited before readiness");

    let settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { settle = resolve; });
    await expect(proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      transactionId: TRANSACTION_ID,
      candidate: fixture.candidate,
    }, {
      port: 45680,
      verifyCandidate: async () => {},
      spawn: () => ({ exited, kill: () => settle(0) }),
      fetch: async () => { throw new Error("not listening"); },
      readinessTimeoutMs: 20,
    })).rejects.toThrow("before timeout");
  });

  test("escalates TERM to KILL and reports undrainable cleanup beside the primary error", async () => {
    const fixture = await candidateFixture();
    let settle!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { settle = resolve; });
    const signals: Array<string | number | undefined> = [];
    await proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      transactionId: TRANSACTION_ID,
      candidate: fixture.candidate,
    }, {
      port: 45681,
      verifyCandidate: async () => {},
      spawn: () => ({
        exited,
        kill: (signal) => { signals.push(signal); if (signal === "SIGKILL") settle(0); },
      }),
      fetch: async (url) => {
        if (url.endsWith("/healthz")) throw new Error("drained");
        return Response.json(readiness());
      },
      drainTimeoutMs: 5,
    });
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);

    let stop!: (code: number) => void;
    const stopped = new Promise<number>((resolve) => { stop = resolve; });
    try {
      await proveHomeUpgradeCandidate({
        vault: fixture.vault,
        vaultId: "vault-proof-id",
        transactionId: TRANSACTION_ID,
        candidate: fixture.candidate,
      }, {
        port: 45682,
        verifyCandidate: async () => {},
        spawn: () => ({ exited: stopped, kill: () => stop(0) }),
        fetch: async () => Response.json({ ...readiness(), writesAdmitted: true }),
        drainTimeoutMs: 5,
      });
      throw new Error("expected aggregate failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(String).join("\n")).toContain("readiness does not match");
      expect((error as AggregateError).errors.map(String).join("\n")).toContain("listener did not drain");
    }
  });
});

function readiness() {
  return {
    schema: "dome.product.readiness/v1",
    productVersion: "2.0.0",
    artifactId: "c".repeat(64),
    writesAdmitted: false,
    contractVersions: ["dome.product.readiness/v1"],
    assetVersion: "c".repeat(64),
    vault: { id: "vault-proof-id", name: "vault" },
    device: { id: "local-upgrade-probe", name: "Local upgrade probe", capabilities: [] },
    host: { state: "probation", since: new Date().toISOString() },
    adoption: { state: "current", head: null, adopted: null, lastSuccessAt: null },
    model: { state: "unconfigured" },
    transcription: { state: "unconfigured" },
    nextActions: [{ code: "upgrade-probation", label: "Await commit" }],
  };
}

async function candidateFixture(overrides: { readonly writesAdmitted?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "dome-upgrade-candidate-")));
  roots.push(root);
  const vault = join(root, "vault");
  const release = join(root, "release");
  await mkdir(join(vault, ".dome", "state"), { recursive: true });
  await mkdir(join(release, "runtime"), { recursive: true });
  await mkdir(join(release, "app", "bin"), { recursive: true });
  await mkdir(join(release, "app", "pwa", "dist"), { recursive: true });
  await symlink(process.execPath, join(release, "runtime", "bun"));
  const entrypoint = join(release, "app", "bin", "dome");
  await writeFile(entrypoint, `
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const server = Bun.serve({
  hostname: value("--host"),
  port: Number(value("--port")),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/readyz") return Response.json({
      schema: "dome.product.readiness/v1",
      productVersion: "2.0.0",
      artifactId: "${"c".repeat(64)}",
      writesAdmitted: ${overrides.writesAdmitted ?? false},
      contractVersions: ["dome.product.readiness/v1"],
      assetVersion: "${"c".repeat(64)}",
      vault: { id: "vault-proof-id", name: "vault" },
      device: { id: "local-upgrade-probe", name: "Local upgrade probe", capabilities: [] },
      host: { state: "probation", since: new Date().toISOString() },
      adoption: { state: "current", head: null, adopted: null, lastSuccessAt: null },
      model: { state: "unconfigured" },
      transcription: { state: "unconfigured" },
      nextActions: [{ code: "upgrade-probation", label: "Await commit" }],
    });
    return Response.json({ ok: true });
  },
});
const close = () => { server.stop(true); process.exit(0); };
process.on("SIGTERM", close);
process.on("SIGINT", close);
await new Promise(() => {});
`, { mode: 0o700 });
  await chmod(entrypoint, 0o700);
  return {
    vault,
    candidate: {
      artifactId: "c".repeat(64),
      version: "2.0.0",
      releasePath: release,
      manifestSha256: "d".repeat(64),
    },
  } as const;
}

async function availablePort(): Promise<number> {
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  return port;
}
