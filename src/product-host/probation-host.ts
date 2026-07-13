// product-host/probation-host: the read-only candidate-validation Adapter.
//
// This implementation deliberately cannot reach openVault, the operational
// store openers, controlled-mutation recovery, ensureVaultId, or the engine
// scheduler. Deleting this module would force those no-write guarantees back
// into the normal Product Host lifecycle and every HTTP mutation route.

import { basename, join } from "node:path";

import {
  PRODUCT_READINESS_SCHEMA,
  type ProductReadiness,
} from "../../contracts/product-readiness";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import {
  inspectExclusiveFileLock,
  withExclusiveFileLock,
} from "../engine/host/file-lock";
import { currentSha, probeAncestry } from "../git";
import { readVaultId } from "./vault-id";
import type { ProductHostWriteAdmission } from "./write-admission";
import { externalProductHostLockPath } from "./host-ownership";

export type ProbationHost = {
  readonly url: string;
  readonly readiness: () => Promise<ProductReadiness>;
  readonly close: () => Promise<void>;
};

export type StartProbationHostResult =
  | { readonly ok: true; readonly value: ProbationHost }
  | {
      readonly ok: false;
      readonly error: { readonly kind: "busy" | "startup-failed"; readonly message: string };
    };

export type ProbationHostOptions = {
  readonly vaultPath: string;
  readonly hostname: string;
  readonly port: number;
  readonly admission: ProductHostWriteAdmission;
  readonly assetVersion?: string | undefined;
  readonly modelState?: "ready" | "unconfigured" | "unreachable" | undefined;
  readonly transcriptionState?: "ready" | "unconfigured" | "unreachable" | undefined;
};

/** Start the strict local validation surface while writes remain impossible. */
export async function startProbationHost(
  options: ProbationHostOptions,
): Promise<StartProbationHostResult> {
  if (options.admission.mode !== "upgrade-probation" || options.admission.writesAdmitted) {
    return failure("startup-failed", "probation requires closed write admission");
  }
  const since = new Date().toISOString();
  let settleStarted!: (result: StartProbationHostResult) => void;
  let startedSettled = false;
  const started = new Promise<StartProbationHostResult>((resolveStarted) => {
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
      lockPath: externalProductHostLockPath(options.vaultPath),
      command: "dome-product-host-upgrade-probation",
    },
    async () => {
      let listener: ReturnType<typeof Bun.serve> | null = null;
      try {
        const vaultLock = await inspectExclusiveFileLock(
          join(options.vaultPath, ".dome", "state", "locks", "product-host.lock"),
        );
        if (vaultLock.kind === "possibly-live") {
          settleStarted(failure("busy", `product host already owns ${options.vaultPath}`));
          return;
        }
        // A definitely stale same-host/dead-PID lock is ignored but never
        // unlinked: probation may inspect rollback state, not repair it.
        // Both probes are read-only and must succeed before the candidate can
        // identify the exact vault it is validating.
        await readVaultId(options.vaultPath);
        await collectReadiness(options, since);

        listener = Bun.serve({
          hostname: options.hostname,
          port: options.port,
          fetch: (request) => probationResponse(request, options, since),
        });
        if (listener.port === undefined) {
          throw new Error("Product Host listener did not report its bound port");
        }
        const localOrigin = listenerOrigin(listener.hostname ?? options.hostname, listener.port);
        settleStarted({
          ok: true,
          value: Object.freeze({
            url: localOrigin,
            readiness: () => collectReadiness(options, since),
            close: async () => {
              requestClose();
              await closed;
            },
          }),
        });
        await closeRequested;
      } catch (error) {
        settleStarted(failure(
          "startup-failed",
          error instanceof Error ? error.message : String(error),
        ));
      } finally {
        listener?.stop(true);
      }
    },
  );

  void ownership.then((result) => {
    if (result.kind === "busy") {
      settleStarted(failure("busy", `product host already owns ${options.vaultPath}`));
    }
  }).catch((error) => {
    settleStarted(failure(
      "startup-failed",
      error instanceof Error ? error.message : String(error),
    ));
  }).finally(settleClosed);

  return started;
}

async function collectReadiness(
  options: ProbationHostOptions,
  since: string,
): Promise<ProductReadiness> {
  const [vaultId, branch, head] = await Promise.all([
    readVaultId(options.vaultPath),
    getCurrentBranch(options.vaultPath),
    currentSha(options.vaultPath),
  ]);
  const adopted = branch === null ? null : await getAdoptedRef(options.vaultPath, branch);
  let adoptionState: ProductReadiness["adoption"]["state"] = "unknown";
  if (branch !== null && head !== null && adopted !== null) {
    if (head === adopted) adoptionState = "current";
    else {
      const ancestry = await probeAncestry({
        path: options.vaultPath,
        ancestor: adopted,
        descendant: head,
      });
      adoptionState = ancestry.kind === "ancestor"
        ? "pending"
        : ancestry.kind === "not-ancestor"
          ? "diverged"
          : "unknown";
    }
  }
  const nextActions: Array<{ code: string; label: string }> = [{
    code: "upgrade-probation",
    label: "Await durable upgrade commit before admitting writes",
  }];
  if (adoptionState === "diverged") {
    nextActions.unshift({ code: "adoption-diverged", label: "Repair or reanchor Git history" });
  }
  if (adoptionState === "unknown") {
    nextActions.unshift({ code: "adoption-unavailable", label: "Restore a readable branch and adopted ref" });
  }
  return Object.freeze({
    schema: PRODUCT_READINESS_SCHEMA,
    productVersion: options.admission.artifact.version,
    artifactId: options.admission.artifact.id,
    writesAdmitted: false,
    contractVersions: Object.freeze([
      "dome.product.readiness/v1",
      "dome.capture/v1",
      "dome.device.pairing/v1",
      "dome.daily.today/v1",
    ]),
    assetVersion: options.assetVersion ?? options.admission.artifact.id,
    vault: Object.freeze({ id: vaultId, name: basename(options.vaultPath) }),
    device: Object.freeze({
      id: "local-upgrade-probe",
      name: "Local upgrade probe",
      capabilities: Object.freeze([]),
    }),
    host: Object.freeze({ state: "probation", since }),
    adoption: Object.freeze({ state: adoptionState, head, adopted, lastSuccessAt: null }),
    model: Object.freeze({ state: options.modelState ?? "unconfigured" }),
    transcription: Object.freeze({ state: options.transcriptionState ?? "unconfigured" }),
    nextActions: Object.freeze(nextActions),
  });
}

async function probationResponse(
  request: Request,
  options: ProbationHostOptions,
  since: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse(200, {
      schema: "dome.http/v1",
      server: "dome",
      state: "probation",
      writesAdmitted: false,
    });
  }
  if (request.method === "GET" && url.pathname === "/readyz") {
    return jsonResponse(200, await collectReadiness(options, since));
  }
  if (request.method === "GET" && url.pathname === "/pair/status") {
    return jsonResponse(503, {
      schema: "dome.device.pairing/v1",
      available: false,
      paired: false,
      error: "upgrade-probation",
    });
  }
  return jsonResponse(503, {
    schema: "dome.http/v1",
    status: "error",
    error: "write-admission-closed",
    message: "The candidate Product Host is validating in write-disabled upgrade probation.",
  });
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function listenerOrigin(hostname: string, port: number): string {
  const host = hostname.includes(":") && !hostname.startsWith("[")
    ? `[${hostname}]`
    : hostname;
  return `http://${host}:${port}`;
}

function failure(
  kind: "busy" | "startup-failed",
  message: string,
): StartProbationHostResult {
  return Object.freeze({ ok: false as const, error: Object.freeze({ kind, message }) });
}
