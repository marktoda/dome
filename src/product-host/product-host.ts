import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  PRODUCT_READINESS_SCHEMA,
  type ProductReadiness,
} from "../../contracts/product-readiness";
import { getCurrentBranch } from "../adopted-ref";
import type { AgentRuntime } from "../assistant/runtime";
import { withExclusiveFileLock } from "../engine/host/file-lock";
import { isWorkingTreeDirty } from "../git";
import { createDomeHttpServer } from "../http/server";
import { recoverControlledMutation } from "../mutation/controlled-mutation";
import { openVault, type Vault } from "../vault";
import { ProductOperationScheduler } from "./operation-scheduler";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3663;
const DEFAULT_POLL_MS = 500;

export type ProductHost = {
  readonly url: string;
  readonly readiness: () => Promise<ProductReadiness>;
  readonly close: () => Promise<void>;
};

export type StartProductHostResult =
  | { readonly ok: true; readonly value: ProductHost }
  | {
      readonly ok: false;
      readonly error: { readonly kind: "busy" | "open-failed" | "startup-failed"; readonly message: string };
    };

export type ProductHostOptions = {
  readonly vaultPath: string;
  readonly bundlesRoot?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly pairCode: string;
  readonly staticDir?: string;
  readonly pollIntervalMs?: number;
  readonly assetVersion?: string;
  readonly productVersion?: string;
  readonly agentRuntime?: AgentRuntime;
  readonly modelState?: "ready" | "unconfigured" | "unreachable";
  readonly transcriptionState?: "ready" | "unconfigured" | "unreachable";
};

type HostState = {
  readonly since: string;
  readonly vaultId: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  recoveryIssue: "diverged" | "working-tree-conflict" | "branch-mismatch" | null;
};

/** Start one loopback Product Host and hold exclusive ownership until close. */
export async function startProductHost(
  options: ProductHostOptions,
): Promise<StartProductHostResult> {
  const vaultPath = resolve(options.vaultPath);
  const hostname = options.hostname ?? DEFAULT_HOST;
  if (!isLoopbackHost(hostname)) {
    return failure("startup-failed", "P2 Product Host is loopback-only");
  }
  if (options.pairCode.trim().length < 8) {
    return failure("startup-failed", "pairing code must contain at least 8 characters");
  }
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    return failure("startup-failed", "poll interval must be a positive integer");
  }

  let settleStarted!: (result: StartProductHostResult) => void;
  let startedSettled = false;
  const started = new Promise<StartProductHostResult>((resolveStarted) => {
    settleStarted = (result) => {
      if (startedSettled) return;
      startedSettled = true;
      resolveStarted(result);
    };
  });
  let requestClose!: () => void;
  const closeRequested = new Promise<void>((resolveClose) => { requestClose = resolveClose; });
  let settleClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => { settleClosed = resolveClosed; });

  const ownership = withExclusiveFileLock(
    {
      lockPath: join(vaultPath, ".dome", "state", "locks", "product-host.lock"),
      command: "dome-product-host",
    },
    async () => {
      let vault: Vault | null = null;
      let listener: ReturnType<typeof Bun.serve> | null = null;
      let http: ReturnType<typeof createDomeHttpServer> | null = null;
      const controller = new AbortController();
      const scheduler = new ProductOperationScheduler();
      let poll: Promise<void> = Promise.resolve();
      try {
        const branch = await getCurrentBranch(vaultPath);
        let recoveryIssue: HostState["recoveryIssue"] = null;
        if (branch !== null) {
          const recovered = await recoverControlledMutation({ vaultPath, branch });
          if (recovered.kind === "busy") {
            settleStarted(failure("startup-failed", "controlled mutation recovery is busy"));
            return;
          }
          if (recovered.kind === "diverged") recoveryIssue = "diverged";
          if (
            recovered.kind === "no-commit" &&
            recovered.reason !== "candidate-not-landed"
          ) {
            recoveryIssue = recovered.reason;
          }
        }
        const opened = await openVault({
          path: vaultPath,
          ...(options.bundlesRoot !== undefined ? { bundlesRoot: options.bundlesRoot } : {}),
        });
        if (!opened.ok) {
          settleStarted(failure("open-failed", opened.error.kind));
          return;
        }
        vault = opened.value;
        const state: HostState = {
          since: new Date().toISOString(),
          vaultId: await ensureVaultId(vaultPath),
          lastSuccessAt: null,
          lastError: null,
          recoveryIssue,
        };
        await scheduler.run("engine-tick", ({ signal }) => tick(vault!, state, signal));

        const readiness = (): Promise<ProductReadiness> =>
          buildReadiness(vault!, state, options);
        http = createDomeHttpServer({
          vaultPath,
          vault,
          token: `product-host-internal-${randomUUID()}`,
          loopbackPairing: { code: options.pairCode.trim() },
          readiness,
          operationScheduler: scheduler,
          ...(options.staticDir !== undefined ? { staticDir: options.staticDir } : {}),
          ...(options.agentRuntime !== undefined ? { agentRuntime: options.agentRuntime } : {}),
        });
        listener = Bun.serve({
          hostname,
          port: options.port ?? DEFAULT_PORT,
          fetch: http.fetch,
        });
        poll = pollVault(vault, state, scheduler, pollIntervalMs, controller.signal);
        const host: ProductHost = Object.freeze({
          url: `http://${listener.hostname}:${listener.port}`,
          readiness,
          close: async () => {
            requestClose();
            await closed;
          },
        });
        settleStarted({ ok: true, value: host });
        await closeRequested;
      } catch (error) {
        settleStarted(failure(
          "startup-failed",
          error instanceof Error ? error.message : String(error),
        ));
      } finally {
        controller.abort();
        scheduler.close();
        http?.close();
        listener?.stop(true);
        await poll.catch(() => {});
        await waitForLeasedWork(scheduler, 5_000);
        if (vault !== null) await vault.close();
      }
    },
  );

  void ownership.then((result) => {
    if (result.kind === "busy") {
      settleStarted(failure("busy", `product host already owns ${vaultPath}`));
    }
  }).catch((error) => {
    settleStarted(failure(
      "startup-failed",
      error instanceof Error ? error.message : String(error),
    ));
  }).finally(settleClosed);

  return started;
}

async function pollVault(
  vault: Vault,
  state: HostState,
  scheduler: ProductOperationScheduler,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await wait(pollIntervalMs, signal);
    if (signal.aborted) break;
    try {
      await scheduler.run("engine-tick", ({ signal: operationSignal }) =>
        tick(vault, state, operationSignal), { signal });
    } catch {
      if (!signal.aborted) state.lastError = "engine-tick-cancelled";
    }
  }
}

async function waitForLeasedWork(
  scheduler: ProductOperationScheduler,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = scheduler.snapshot();
    if (snapshot.views.active === 0 && snapshot.mutations.active === 0) return;
    await wait(10, new AbortController().signal);
  }
}

async function tick(vault: Vault, state: HostState, signal: AbortSignal): Promise<void> {
  try {
    if (await isWorkingTreeDirty(vault.path)) {
      state.lastError = "working-tree-dirty";
      return;
    }
    const result = await vault.sync({ signal });
    if (result.kind === "adopted" || result.kind === "in-sync") {
      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
    } else if (result.kind === "blocked" || result.kind === "diverged") {
      state.lastError = result.kind;
    }
  } catch (error) {
    if (!signal.aborted) {
      state.lastError = error instanceof Error ? error.message : String(error);
    }
  }
}

async function buildReadiness(
  vault: Vault,
  state: HostState,
  options: ProductHostOptions,
): Promise<ProductReadiness> {
  const adoption = await vault.getAdoptionStatus();
  const adoptionState = adoption.diverged
    ? "diverged" as const
    : adoption.adopted === null
      ? "unknown" as const
      : adoption.syncNeeded
        ? "pending" as const
        : "current" as const;
  const blocked = state.recoveryIssue !== null || adoption.diverged || adoption.adopted === null;
  const hostState = blocked
    ? "blocked" as const
    : state.lastError !== null
      ? "degraded" as const
      : "ready" as const;
  const nextActions: Array<{ code: string; label: string }> = [];
  if (adoption.diverged) nextActions.push({ code: "adoption-diverged", label: "Repair or reanchor Git history" });
  if (state.recoveryIssue !== null) nextActions.push({ code: `mutation-${state.recoveryIssue}`, label: "Resolve controlled-mutation recovery state" });
  if (state.lastError === "working-tree-dirty") nextActions.push({ code: "working-tree-dirty", label: "Commit or discard external working-tree changes" });
  if (adoption.syncNeeded && !adoption.diverged) nextActions.push({ code: "adoption-pending", label: "Wait for the host to adopt pending commits" });
  return Object.freeze({
    schema: PRODUCT_READINESS_SCHEMA,
    productVersion: options.productVersion ?? "0.1.0-dev",
    contractVersions: Object.freeze([
      "dome.product.readiness/v1",
      "dome.capture/v1",
      "dome.pairing/v1",
      "dome.daily.today/v1",
    ]),
    assetVersion: options.assetVersion ?? "development",
    vault: Object.freeze({
      id: state.vaultId,
      name: basename(vault.path),
    }),
    device: Object.freeze({
      id: "loopback-browser",
      name: "Loopback browser",
      capabilities: Object.freeze(["capture", "converse", "read", "resolve"]),
    }),
    host: Object.freeze({ state: hostState, since: state.since }),
    adoption: Object.freeze({
      state: blocked && !adoption.diverged ? "blocked" : adoptionState,
      head: adoption.head,
      adopted: adoption.adopted,
      lastSuccessAt: state.lastSuccessAt,
    }),
    model: Object.freeze({ state: options.modelState ?? "unconfigured" }),
    transcription: Object.freeze({ state: options.transcriptionState ?? "unconfigured" }),
    nextActions: Object.freeze(nextActions),
  });
}

async function ensureVaultId(vaultPath: string): Promise<string> {
  const path = join(vaultPath, ".dome", "state", "product-host-id");
  try {
    const current = (await readFile(path, "utf8")).trim();
    if (current.length > 0) return current;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const created = randomUUID();
  try {
    await writeFile(path, `${created}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    return (await readFile(path, "utf8")).trim();
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function failure(
  kind: "busy" | "open-failed" | "startup-failed",
  message: string,
): StartProductHostResult {
  return Object.freeze({ ok: false as const, error: Object.freeze({ kind, message }) });
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1" || value === "[::1]";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveWait) => {
    const timeout = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolveWait();
    }
  });
}
