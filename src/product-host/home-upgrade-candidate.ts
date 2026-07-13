// product-host/home-upgrade-candidate: real managed-release probation proof.
//
// This Module owns the child lifecycle and the network observation together:
// callers either receive exact, stopped-candidate evidence or an error.  No
// listening candidate can escape through a successful return.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  PRODUCT_READINESS_SCHEMA,
  parseProductReadiness,
  type ProductReadiness,
} from "../../contracts/product-readiness";
import type {
  HomeUpgradeArtifactEvidence,
  HomeUpgradeProbationProof,
} from "./home-upgrade-transaction";
import { verifyHomeArtifact } from "./home-artifact";

type CandidateChild = {
  readonly exited: Promise<number>;
  readonly kill: (signal?: NodeJS.Signals | number) => void;
};

export type HomeUpgradeCandidateDeps = {
  readonly hostname?: string | undefined;
  readonly port?: number | undefined;
  readonly readinessTimeoutMs?: number | undefined;
  readonly drainTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly spawn?: ((command: ReadonlyArray<string>) => CandidateChild) | undefined;
  readonly fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Test seam; production performs complete artifact verification + manifest binding. */
  readonly verifyCandidate?: ((candidate: HomeUpgradeArtifactEvidence) => Promise<void>) | undefined;
};

/** Launch the exact candidate in probation, prove identity, then prove drain. */
export async function proveHomeUpgradeCandidate(input: {
  readonly vault: string;
  readonly vaultId: string;
  readonly transactionId: string;
  readonly candidate: HomeUpgradeArtifactEvidence;
}, deps: HomeUpgradeCandidateDeps = {}): Promise<HomeUpgradeProbationProof> {
  const hostname = deps.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1" && hostname !== "::1" && hostname !== "localhost") {
    throw new Error("upgrade candidate probation must use loopback");
  }
  const port = deps.port ?? 3663;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("upgrade candidate probation port is invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.candidate.artifactId) ||
    input.candidate.releasePath.length === 0 || input.vaultId.length === 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.transactionId)) {
    throw new Error("upgrade candidate probation input is invalid");
  }
  const origin = `http://${hostname === "::1" ? "[::1]" : hostname}:${port}`;
  await (deps.verifyCandidate ?? assertCandidateArtifact)(input.candidate);
  const command = candidateCommand(input.vault, input.candidate, hostname, port);
  const child = (deps.spawn ?? spawnCandidate)(command);
  let childExited = false;
  let childExitCode: number | null = null;
  void child.exited.then((code) => {
    childExited = true;
    childExitCode = code;
  });
  const request = deps.fetch ?? fetch;
  let proof: HomeUpgradeProbationProof | null = null;
  let primaryError: unknown | null = null;
  try {
    const readiness = await waitForExactReadiness({
      url: `${origin}/readyz`,
      request,
      timeoutMs: deps.readinessTimeoutMs ?? 15_000,
      childState: () => ({ exited: childExited, code: childExitCode }),
      expected: input,
    });
    await proveClosedProbationBehavior(origin, request);
    if (childExited) throw new Error(`upgrade candidate exited during probation (${childExitCode ?? "unknown"})`);
    proof = Object.freeze({
      schema: "dome.home-upgrade-probation-proof/v1" as const,
      transactionId: input.transactionId,
      readinessSchema: PRODUCT_READINESS_SCHEMA,
      hostState: "probation" as const,
      artifactId: readiness.artifactId,
      productVersion: readiness.productVersion,
      vaultId: readiness.vault.id,
      writesAdmitted: false as const,
      provenAt: (deps.now?.() ?? new Date()).toISOString(),
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError: unknown | null = null;
  try {
    if (!childExited) child.kill("SIGTERM");
    const exited = await settleChild(child, deps.drainTimeoutMs ?? 5_000);
    if (!exited) {
      child.kill("SIGKILL");
      if (!await settleChild(child, deps.drainTimeoutMs ?? 5_000)) {
        throw new Error("upgrade candidate did not terminate after SIGKILL");
      }
    }
    await provePortDrained(`${origin}/healthz`, request, deps.drainTimeoutMs ?? 5_000);
  } catch (error) {
    cleanupError = error;
  }
  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError([primaryError, cleanupError], "candidate probation and cleanup both failed");
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
  if (proof === null) throw new Error("upgrade candidate probation completed without proof");
  return proof;
}

async function proveClosedProbationBehavior(
  origin: string,
  request: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<void> {
  const pairing = await request(`${origin}/pair/status`, {
    signal: AbortSignal.timeout(1_000),
    cache: "no-store",
  });
  const pairingBody = await readBoundedJson(pairing) as Record<string, unknown>;
  if (pairing.status !== 503 || pairingBody["schema"] !== "dome.device.pairing/v1" ||
    pairingBody["available"] !== false || pairingBody["paired"] !== false ||
    pairingBody["error"] !== "upgrade-probation") {
    throw new Error("upgrade candidate pairing surface is not closed during probation");
  }
  // Deliberately unauthenticated and credential-free: a mistakenly normal
  // host must reject this probe before any mutator can observe it.
  const mutation = await request(`${origin}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "candidate probation write-closure probe" }),
    signal: AbortSignal.timeout(1_000),
    cache: "no-store",
  });
  const mutationBody = await readBoundedJson(mutation) as Record<string, unknown>;
  if (mutation.status !== 503 || mutationBody["schema"] !== "dome.http/v1" ||
    mutationBody["error"] !== "write-admission-closed") {
    throw new Error("upgrade candidate mutation surface is not closed during probation");
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 64 * 1024)) {
    throw new Error("upgrade candidate response exceeds its size budget");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 64 * 1024) throw new Error("upgrade candidate response exceeds its size budget");
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("upgrade candidate response is not JSON"); }
}

async function assertCandidateArtifact(candidate: HomeUpgradeArtifactEvidence): Promise<void> {
  const manifestPath = join(candidate.releasePath, "manifest.json");
  const manifestBytes = await readFile(manifestPath);
  const manifestHash = createHash("sha256").update(manifestBytes).digest("hex");
  if (manifestHash !== candidate.manifestSha256) {
    throw new Error("upgrade candidate manifest changed before probation launch");
  }
  const verified = await verifyHomeArtifact(candidate.releasePath);
  if (verified.artifact.id !== candidate.artifactId || verified.product.version !== candidate.version) {
    throw new Error("upgrade candidate identity changed before probation launch");
  }
}

function candidateCommand(
  vault: string,
  candidate: HomeUpgradeArtifactEvidence,
  hostname: string,
  port: number,
): ReadonlyArray<string> {
  return Object.freeze([
    join(candidate.releasePath, "runtime", "bun"),
    join(candidate.releasePath, "app", "bin", "dome"),
    "home",
    "--upgrade-probation",
    "--vault", vault,
    "--host", hostname,
    "--port", String(port),
    "--static-dir", join(candidate.releasePath, "app", "pwa", "dist"),
  ]);
}

function spawnCandidate(command: ReadonlyArray<string>): CandidateChild {
  const child = Bun.spawn([...command], {
    cwd: dirname(command[1]!),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: {
      HOME: process.env["HOME"] ?? "",
      PATH: [dirname(command[0]!), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      TMPDIR: process.env["TMPDIR"] ?? "/tmp",
    },
  });
  return Object.freeze({
    exited: child.exited,
    kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
  });
}

async function waitForExactReadiness(input: {
  readonly url: string;
  readonly request: (url: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs: number;
  readonly childState: () => { readonly exited: boolean; readonly code: number | null };
  readonly expected: {
    readonly vaultId: string;
    readonly candidate: HomeUpgradeArtifactEvidence;
  };
}): Promise<ProductReadiness> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const state = input.childState();
    if (state.exited) throw new Error(`upgrade candidate exited before readiness (${state.code ?? "unknown"})`);
    try {
      const response = await input.request(input.url, {
        signal: AbortSignal.timeout(Math.min(1_000, Math.max(1, deadline - Date.now()))),
        cache: "no-store",
      });
      if (response.status === 200) {
        const readiness = await readBoundedJson(response);
        assertExactReadiness(readiness, input.expected);
        return readiness;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("upgrade candidate readiness")) throw error;
    }
    if (Date.now() >= deadline) throw new Error("upgrade candidate did not become exactly ready before timeout");
    await Bun.sleep(25);
  }
}

function assertExactReadiness(
  readiness: unknown,
  expected: { readonly vaultId: string; readonly candidate: HomeUpgradeArtifactEvidence },
): asserts readiness is ProductReadiness {
  let parsed: ProductReadiness;
  try { parsed = parseProductReadiness(readiness); }
  catch { throw new Error("upgrade candidate readiness does not match exact probation identity"); }
  if (parsed.schema !== PRODUCT_READINESS_SCHEMA ||
    parsed.artifactId !== expected.candidate.artifactId ||
    parsed.productVersion !== expected.candidate.version ||
    parsed.writesAdmitted !== false || parsed.host.state !== "probation" ||
    parsed.vault.id !== expected.vaultId) {
    throw new Error("upgrade candidate readiness does not match exact probation identity");
  }
}

async function settleChild(child: CandidateChild, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function provePortDrained(
  url: string,
  request: (url: string, init?: RequestInit) => Promise<Response>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await request(url, { signal: AbortSignal.timeout(250), cache: "no-store" });
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error("upgrade candidate listener did not drain");
    await Bun.sleep(25);
  }
}
