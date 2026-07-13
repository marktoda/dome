import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proveHomeUpgradeCandidate } from "../../src/product-host/home-upgrade-candidate";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("managed Home upgrade candidate", () => {
  test("launches the pinned child, proves exact probation, terminates, and drains", async () => {
    const fixture = await candidateFixture();
    const port = await availablePort();
    const proof = await proveHomeUpgradeCandidate({
      vault: fixture.vault,
      vaultId: "vault-proof-id",
      candidate: fixture.candidate,
    }, { port, readinessTimeoutMs: 5_000, drainTimeoutMs: 2_000 });
    expect(proof).toMatchObject({
      schema: "dome.home-upgrade-probation-proof/v1",
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
      candidate: fixture.candidate,
    }, { port, readinessTimeoutMs: 2_000, drainTimeoutMs: 2_000 })).rejects.toThrow(
      "does not match exact probation identity",
    );
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});

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
      vault: { id: "vault-proof-id", name: "vault" },
      host: { state: "probation", since: new Date().toISOString() },
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
