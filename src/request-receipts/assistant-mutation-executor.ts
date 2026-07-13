import type { ProductOperationScheduler } from "../product-host/operation-scheduler";
import type {
  FinishRequestReceiptInput,
  RequestReceiptOperation,
  RequestReceiptOperationClass,
  RequestReceipts,
} from "./request-receipts";

export type AuthenticatedMutationActor = Readonly<{
  requestId: string;
  actorId: "owner";
  deviceId: string;
  credentialId: string;
  transport: "cookie" | "bearer";
}>;

export type AssistantMutationExecutor = Readonly<{
  execute: <T>(input: {
    readonly actor: AuthenticatedMutationActor;
    readonly operation: RequestReceiptOperation;
    readonly operationClass: RequestReceiptOperationClass;
    readonly signal?: AbortSignal | undefined;
    readonly mutate: (signal: AbortSignal) => Promise<{ readonly value: T; readonly terminal: FinishRequestReceiptInput }>;
  }) => Promise<T>;
}>;

export class AssistantMutationAdmissionError extends Error {
  constructor() { super("assistant mutation admission failed before execution"); }
}

export class AssistantMutationOutcomeUnknownError extends Error {
  constructor(readonly operationId: string) {
    super(`assistant mutation outcome is unknown; receipt ${operationId}; do not replay`);
  }
}

export function createAssistantMutationExecutor(input: {
  readonly receipts: Pick<RequestReceipts, "admit">;
  readonly hostInstanceId: string;
  readonly scheduler: Pick<ProductOperationScheduler, "run">;
}): AssistantMutationExecutor {
  return Object.freeze({
    execute: async <T>(operation: {
      actor: AuthenticatedMutationActor;
      operation: RequestReceiptOperation;
      operationClass: RequestReceiptOperationClass;
      signal?: AbortSignal | undefined;
      mutate: (signal: AbortSignal) => Promise<{ value: T; terminal: FinishRequestReceiptInput }>;
    }): Promise<T> => input.scheduler.run(operation.operationClass, async ({ signal }) => {
      let lease;
      try {
        lease = input.receipts.admit({
          ...operation.actor,
          hostInstanceId: input.hostInstanceId,
          executor: "assistant",
          operation: operation.operation,
          operationClass: operation.operationClass,
        });
      } catch {
        throw new AssistantMutationAdmissionError();
      }
      let completed;
      try {
        completed = await operation.mutate(signal);
      } catch {
        try {
          lease.finish({
            state: "interrupted",
            resultCode: "mutation-outcome-unknown",
            adoptionState: "unknown",
            recoveryRequired: true,
          });
        } catch {
          // Startup interruption retains uncertainty if finalization also fails.
        }
        throw new AssistantMutationOutcomeUnknownError(lease.operationId);
      }
      try {
        const finished = lease.finish(completed.terminal);
        if (finished.kind === "terminal-conflict") {
          throw new AssistantMutationOutcomeUnknownError(lease.operationId);
        }
      } catch (error) {
        if (error instanceof AssistantMutationOutcomeUnknownError) throw error;
        throw new AssistantMutationOutcomeUnknownError(lease.operationId);
      }
      return completed.value;
    }, operation.signal !== undefined ? { signal: operation.signal } : {}),
  });
}
