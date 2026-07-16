import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  PRODUCT_READINESS_SCHEMA,
  type ProductReadiness,
} from "../../contracts/product-readiness";
import { getCurrentBranch } from "../adopted-ref";
import type { AgentRuntime } from "../assistant/runtime";
import {
  openDeviceAuthority,
  type DeviceAuthority,
} from "../device-authority/device-authority";
import { isWorkingTreeDirty } from "../git";
import { createDomeHttpServer } from "../http/server";
import type { DeviceRequestContext } from "../http/device-request-auth";
import { recoverControlledMutation } from "../mutation/controlled-mutation";
import { openRequestReceiptsDb } from "../request-receipts/db";
import {
  bindHttpRequestReceiptRecorder,
  createRequestReceipts,
  type RequestReceipts,
} from "../request-receipts/request-receipts";
import { createAssistantMutationExecutor } from "../request-receipts/assistant-mutation-executor";
import { openVault, type Vault } from "../vault";
import type { ModelProvider, ModelStepProvider } from "../engine/core/model-invoke";
import { ProductOperationScheduler } from "./operation-scheduler";
import { ensureVaultId } from "./vault-id";
import { withProductHostOwnership } from "./host-ownership";
import {
  acquireHomeStartupAdmission,
  type HomeStartupAdmissionDeps,
} from "./home-lifecycle-suspension";
import { startProbationHost } from "./probation-host";
import {
  inspectHomeUpgradeAdmission,
  type HomeUpgradeTransactionDeps,
} from "./home-upgrade-transaction";
import {
  resolveProductHostWriteAdmission,
  type ProductHostLaunch,
  type ProductHostWriteAdmission,
} from "./write-admission";

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
  readonly externalOrigin?: string;
  readonly staticDir?: string;
  readonly pollIntervalMs?: number;
  readonly assetVersion?: string;
  readonly productVersion?: string;
  readonly agentRuntime?: AgentRuntime;
  readonly modelProvider?: ModelProvider;
  readonly modelStepProvider?: ModelStepProvider;
  readonly modelState?: "ready" | "unconfigured" | "unreachable";
  /** Re-read bounded local provider readiness without restarting Home. */
  readonly resolveModelState?: () => Promise<"ready" | "unconfigured" | "unreachable">;
  readonly transcriptionState?: "ready" | "unconfigured" | "unreachable";
  /**
   * Upgrade probation is a distinct, permanently write-closed launch mode.
   * This checkpoint deliberately has no committed-upgrade launch mode.
   */
  readonly launch?: ProductHostLaunch;
};

type ProductHostRuntimeDeps = {
  /** Internal path dependency used by isolated lifecycle/startup tests. */
  readonly upgradeTransaction?: HomeUpgradeTransactionDeps | undefined;
  /** Internal provenance/evidence dependencies for exact lifecycle resume. */
  readonly homeStartup?: HomeStartupAdmissionDeps | undefined;
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
  runtimeDeps: ProductHostRuntimeDeps = {},
): Promise<StartProductHostResult> {
  let vaultPath: string;
  try {
    // One canonical vault identity feeds admission, both ownership locks, the
    // normal runtime, and probation. Aliases must never acquire distinct locks.
    vaultPath = await realpath(resolve(options.vaultPath));
  } catch {
    return failure("open-failed", "vault path does not exist or cannot be canonicalized");
  }
  const hostname = options.hostname ?? DEFAULT_HOST;
  if (!isLoopbackHost(hostname)) {
    return failure(
      "startup-failed",
      "Product Host binds loopback; configure externalOrigin for a private HTTPS proxy",
    );
  }
  const externalOrigin = validateExternalOrigin(options.externalOrigin);
  if (!externalOrigin.ok) return failure("startup-failed", externalOrigin.message);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    return failure("startup-failed", "poll interval must be a positive integer");
  }
  let admission: ProductHostWriteAdmission;
  try {
    admission = resolveProductHostWriteAdmission({
      launch: options.launch,
      developmentVersion: options.productVersion ?? "0.1.0-dev",
      developmentArtifactId: options.assetVersion ?? "development",
    });
  } catch (error) {
    return failure("startup-failed", error instanceof Error ? error.message : String(error));
  }
  if (admission.mode === "upgrade-probation") {
    return startProbationHost({
      vaultPath,
      hostname,
      port: options.port ?? DEFAULT_PORT,
      admission,
      ...(options.assetVersion !== undefined ? { assetVersion: options.assetVersion } : {}),
      ...(options.modelState !== undefined ? { modelState: options.modelState } : {}),
      ...(options.transcriptionState !== undefined
        ? { transcriptionState: options.transcriptionState }
        : {}),
    });
  }

  // The deep lifecycle Module atomically crosses lifecycle -> operational.
  // The returned SHARED lease remains outside both Product Host locks and
  // lives until complete host cleanup.
  const writerAdmission = await acquireHomeStartupAdmission({
    vaultPath,
    launchArtifact: admission.artifact,
  }, runtimeDeps.homeStartup);
  if (!writerAdmission.ok) {
    const operation = writerAdmission.error.operationId === undefined
      ? ""
      : ` (suspension operation ${writerAdmission.error.operationId})`;
    return failure(
      "startup-failed",
      `Dome Home startup admission is closed: ${writerAdmission.error.message}${operation}`,
    );
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

  const ownership = withProductHostOwnership(
    vaultPath,
    async () => {
      let vault: Vault | null = null;
      let listener: ReturnType<typeof Bun.serve> | null = null;
      let http: ReturnType<typeof createDomeHttpServer> | null = null;
      let deviceAuthority: DeviceAuthority | null = null;
      let requestReceipts: RequestReceipts | null = null;
      const controller = new AbortController();
      const scheduler = new ProductOperationScheduler();
      let poll: Promise<void> = Promise.resolve();
      try {
        const upgradeAdmission = await inspectHomeUpgradeAdmission(
          vaultPath,
          runtimeDeps.upgradeTransaction,
          admission.artifact,
        );
        if (!upgradeAdmission.admitted) {
          settleStarted(failure(
            "startup-failed",
            `Dome Home write admission is closed: ${upgradeAdmission.reason}`,
          ));
          return;
        }
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
        const hostInstanceId = randomUUID();
        const openedReceipts = await openRequestReceiptsDb({
          path: join(vaultPath, ".dome", "state", "request-receipts.db"),
        });
        if (!openedReceipts.ok) {
          settleStarted(failure(
            "startup-failed",
            `request receipts could not open: ${openedReceipts.error.kind}`,
          ));
          return;
        }
        requestReceipts = createRequestReceipts(openedReceipts.value.db);
        requestReceipts.interruptAdmitted({ exceptHostInstanceId: hostInstanceId });
        const opened = await openVault({
          path: vaultPath,
          ...(options.bundlesRoot !== undefined ? { bundlesRoot: options.bundlesRoot } : {}),
          ...(options.modelProvider !== undefined ? { modelProvider: options.modelProvider } : {}),
          ...(options.modelStepProvider !== undefined ? { modelStepProvider: options.modelStepProvider } : {}),
        });
        if (!opened.ok) {
          settleStarted(failure("open-failed", opened.error.kind));
          return;
        }
        vault = opened.value;
        const openedAuthority = await openDeviceAuthority({
          path: join(vaultPath, ".dome", "state", "device-authority.db"),
        });
        if (!openedAuthority.ok) {
          settleStarted(failure(
            "startup-failed",
            `device authority could not open: ${openedAuthority.error.kind}`,
          ));
          return;
        }
        deviceAuthority = openedAuthority.value.authority;
        const state: HostState = {
          since: new Date().toISOString(),
          vaultId: await ensureVaultId(vaultPath),
          lastSuccessAt: null,
          lastError: null,
          recoveryIssue,
        };
        await scheduler.run("engine-tick", ({ signal }) => tick(vault!, state, signal));

        const readiness = (client?: DeviceRequestContext): Promise<ProductReadiness> =>
          buildReadiness(vault!, state, options, admission, deviceAuthority!, client);
        let allowedOrigins: ReadonlyArray<string> = Object.freeze([]);
        http = createDomeHttpServer({
          vaultPath,
          vault,
          deviceAuth: {
            authority: deviceAuthority,
            allowedOrigins: () => allowedOrigins,
          },
          readiness,
          operationScheduler: scheduler,
          requestReceiptRecorder: bindHttpRequestReceiptRecorder(requestReceipts, hostInstanceId),
          assistantMutationExecutor: createAssistantMutationExecutor({
            receipts: requestReceipts,
            hostInstanceId,
            scheduler,
          }),
          ...(options.staticDir !== undefined ? { staticDir: options.staticDir } : {}),
          ...(options.agentRuntime !== undefined ? { agentRuntime: options.agentRuntime } : {}),
          ...(options.modelStepProvider !== undefined
            ? { modelStepProvider: options.modelStepProvider }
            : {}),
        });
        listener = Bun.serve({
          hostname,
          port: options.port ?? DEFAULT_PORT,
          fetch: http.fetch,
        });
        if (listener.port === undefined) {
          throw new Error("Product Host listener did not report its bound port");
        }
        const localOrigin = listenerOrigin(listener.hostname ?? hostname, listener.port);
        allowedOrigins = Object.freeze([
          localOrigin,
          ...(externalOrigin.value === null || externalOrigin.value === localOrigin
            ? []
            : [externalOrigin.value]),
        ]);
        poll = pollVault(vault, state, scheduler, pollIntervalMs, controller.signal);
        const host: ProductHost = Object.freeze({
          url: localOrigin,
          readiness: () => readiness(),
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
        let cleanupFailure: unknown = null;
        const cleanup = async (operation: () => void | Promise<void>) => {
          try { await operation(); }
          catch (error) { if (cleanupFailure === null) cleanupFailure = error; }
        };
        await cleanup(() => controller.abort());
        await cleanup(() => scheduler.close());
        await cleanup(() => listener?.stop(true));
        await cleanup(async () => { if (http !== null) await http.close(); });
        await cleanup(async () => { await poll.catch(() => {}); });
        await cleanup(async () => { await scheduler.whenIdle(); });
        await cleanup(() => requestReceipts?.close());
        await cleanup(() => deviceAuthority?.close());
        await cleanup(async () => { if (vault !== null) await vault.close(); });
        if (cleanupFailure !== null) throw cleanupFailure;
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
  }).finally(() => {
    writerAdmission.lease.close();
    settleClosed();
  });

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
  admission: ProductHostWriteAdmission,
  authority: DeviceAuthority,
  client?: DeviceRequestContext,
): Promise<ProductReadiness> {
  const adoption = await vault.getAdoptionStatus();
  let modelState = options.modelState ?? "unconfigured";
  if (options.resolveModelState !== undefined) {
    try { modelState = await options.resolveModelState(); }
    catch { modelState = "unreachable"; }
  }
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
    productVersion: admission.artifact.version,
    artifactId: admission.artifact.id,
    writesAdmitted: admission.writesAdmitted,
    contractVersions: Object.freeze([
      "dome.product.readiness/v1",
      "dome.capture/v1",
      "dome.device.pairing/v1",
      "dome.daily.today/v1",
    ]),
    assetVersion: options.assetVersion ?? "development",
    vault: Object.freeze({
      id: state.vaultId,
      name: basename(vault.path),
    }),
    device: readinessDevice(authority, client),
    host: Object.freeze({ state: hostState, since: state.since }),
    adoption: Object.freeze({
      state: blocked && !adoption.diverged ? "blocked" : adoptionState,
      head: adoption.head,
      adopted: adoption.adopted,
      lastSuccessAt: state.lastSuccessAt,
    }),
    model: Object.freeze({ state: modelState }),
    transcription: Object.freeze({ state: options.transcriptionState ?? "unconfigured" }),
    nextActions: Object.freeze(nextActions),
  });
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

function validateExternalOrigin(value: string | undefined):
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly message: string } {
  if (value === undefined) return { ok: true, value: null };
  try {
    const parsed = new URL(value);
    const secure = parsed.protocol === "https:";
    const loopbackDevelopment = parsed.protocol === "http:" &&
      isLoopbackOriginHostname(parsed.hostname);
    if (
      (!secure && !loopbackDevelopment) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return {
        ok: false,
        message: "externalOrigin must be HTTPS, or HTTP on loopback for local development, without path, query, or credentials",
      };
    }
    return { ok: true, value: parsed.origin };
  } catch {
    return { ok: false, message: "externalOrigin must be a valid origin" };
  }
}

function isLoopbackOriginHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") ||
    host === "127.0.0.1" || host === "[::1]";
}

function listenerOrigin(hostname: string, port: number): string {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return `http://${host}:${port}`;
}

function readinessDevice(
  authority: DeviceAuthority,
  client: DeviceRequestContext | undefined,
): ProductReadiness["device"] {
  if (client === undefined) {
    return Object.freeze({
      id: "local-console",
      name: "Local console",
      capabilities: Object.freeze([]),
    });
  }
  const device = authority.listDevices().find((candidate) => candidate.id === client.deviceId);
  return Object.freeze({
    id: client.deviceId,
    name: device?.name ?? client.deviceName,
    capabilities: Object.freeze([...client.capabilities].sort()),
  });
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
