/**
 * Product Host operation admission.
 *
 * This Module deliberately knows nothing about HTTP or Vault. It classifies
 * host work into the concurrency lanes from the Product Host contract and
 * lends each admitted operation one cancellation signal.
 */

export type ProductOperationClass =
  | "immutable-adopted-read"
  | "view-execution"
  | "operational-transaction"
  | "workspace-mutation"
  | "engine-tick"
  | "model-generation";

export interface ProductOperationContext {
  readonly signal: AbortSignal;
}

export interface ProductOperationOptions {
  /** Cancels admission or the running operation when aborted. */
  readonly signal?: AbortSignal;
  /** Bounds queueing plus execution time. Omit for no operation deadline. */
  readonly timeoutMs?: number;
}

export interface ProductOperationSchedulerOptions {
  /** Simultaneous view processors. */
  readonly maxConcurrentViews?: number;
  /** Waiting views, excluding active views. */
  readonly maxQueuedViews?: number;
  /** Waiting workspace mutations and engine ticks, excluding the active one. */
  readonly maxQueuedMutations?: number;
  /** Stable overload hint exposed to protocol Adapters. */
  readonly retryAfterMs?: number;
}

export interface ProductOperationSchedulerSnapshot {
  readonly closed: boolean;
  readonly views: { readonly active: number; readonly queued: number };
  readonly mutations: { readonly active: number; readonly queued: number };
  readonly unleasedActive: number;
}

export type ProductOperationCancellationReason =
  | "caller"
  | "timeout"
  | "scheduler-closed";

export class ProductOperationQueueFullError extends Error {
  readonly code = "operation-queue-full" as const;

  constructor(
    readonly operationClass: ProductOperationClass,
    readonly retryAfterMs: number,
  ) {
    super(`The ${operationClass} operation queue is full`);
    this.name = "ProductOperationQueueFullError";
  }
}

export class ProductOperationCancelledError extends Error {
  readonly code = "operation-cancelled" as const;

  constructor(
    readonly operationClass: ProductOperationClass,
    readonly reason: ProductOperationCancellationReason,
  ) {
    super(`The ${operationClass} operation was cancelled (${reason})`);
    this.name = "ProductOperationCancelledError";
  }
}

export class ProductOperationSchedulerClosedError extends Error {
  readonly code = "operation-scheduler-closed" as const;

  constructor() {
    super("The Product Host operation scheduler is closed");
    this.name = "ProductOperationSchedulerClosedError";
  }
}

type Operation<T> = (context: ProductOperationContext) => Promise<T> | T;

interface PendingOperation<T = unknown> {
  readonly operationClass: ProductOperationClass;
  readonly operation: Operation<T>;
  readonly controller: AbortController;
  readonly cleanup: () => void;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
  active: boolean;
}

class OperationLane {
  readonly #queue: PendingOperation[] = [];
  readonly #active = new Set<PendingOperation>();

  constructor(
    private readonly concurrency: number,
    private readonly maxQueued: number,
    private readonly retryAfterMs: number,
  ) {}

  get activeCount(): number {
    return this.#active.size;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  submit<T>(pending: PendingOperation<T>): void {
    if (this.#active.size < this.concurrency) {
      this.#start(pending as PendingOperation);
      return;
    }
    if (this.#queue.length >= this.maxQueued) {
      pending.cleanup();
      pending.reject(
        new ProductOperationQueueFullError(
          pending.operationClass,
          this.retryAfterMs,
        ),
      );
      return;
    }
    this.#queue.push(pending as PendingOperation);
  }

  cancelQueued<T>(pending: PendingOperation<T>, reason: ProductOperationCancellationReason): boolean {
    const erased = pending as PendingOperation;
    const index = this.#queue.indexOf(erased);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    pending.cleanup();
    pending.settled = true;
    pending.reject(new ProductOperationCancelledError(pending.operationClass, reason));
    return true;
  }

  close(): void {
    for (const pending of this.#queue.splice(0)) {
      pending.cleanup();
      pending.settled = true;
      pending.reject(
        new ProductOperationCancelledError(
          pending.operationClass,
          "scheduler-closed",
        ),
      );
    }
    for (const pending of this.#active) {
      pending.controller.abort("scheduler-closed");
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(
          new ProductOperationCancelledError(
            pending.operationClass,
            "scheduler-closed",
          ),
        );
      }
    }
  }

  #start(pending: PendingOperation): void {
    pending.active = true;
    this.#active.add(pending);
    void Promise.resolve()
      .then(() => pending.operation({ signal: pending.controller.signal }))
      .then(
        (value) => {
          if (!pending.settled) {
            pending.settled = true;
            pending.resolve(value);
          }
        },
        (error: unknown) => {
          if (!pending.settled) {
            pending.settled = true;
            pending.reject(error);
          }
        },
      )
      .finally(() => {
        pending.cleanup();
        this.#active.delete(pending);
        this.#drain();
      });
  }

  #drain(): void {
    while (this.#active.size < this.concurrency) {
      const next = this.#queue.shift();
      if (!next) return;
      this.#start(next);
    }
  }
}

const DEFAULT_MAX_CONCURRENT_VIEWS = 2;
const DEFAULT_MAX_QUEUED_VIEWS = 16;
const DEFAULT_MAX_QUEUED_MUTATIONS = 32;
const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * A small admission Interface for Product Host work.
 *
 * Immutable reads, store-owned transactions, and generation hold no host
 * lease. Views use a bounded concurrent lane. Workspace mutations and engine
 * ticks share one bounded FIFO lane, preventing either from racing the other.
 */
export class ProductOperationScheduler {
  readonly #views: OperationLane;
  readonly #mutations: OperationLane;
  readonly #unleased = new Set<PendingOperation>();
  #closed = false;

  constructor(options: ProductOperationSchedulerOptions = {}) {
    const maxConcurrentViews = positiveInteger(
      options.maxConcurrentViews,
      DEFAULT_MAX_CONCURRENT_VIEWS,
      "maxConcurrentViews",
    );
    const maxQueuedViews = nonnegativeInteger(
      options.maxQueuedViews,
      DEFAULT_MAX_QUEUED_VIEWS,
      "maxQueuedViews",
    );
    const maxQueuedMutations = nonnegativeInteger(
      options.maxQueuedMutations,
      DEFAULT_MAX_QUEUED_MUTATIONS,
      "maxQueuedMutations",
    );
    const retryAfterMs = positiveInteger(
      options.retryAfterMs,
      DEFAULT_RETRY_AFTER_MS,
      "retryAfterMs",
    );
    this.#views = new OperationLane(
      maxConcurrentViews,
      maxQueuedViews,
      retryAfterMs,
    );
    this.#mutations = new OperationLane(1, maxQueuedMutations, retryAfterMs);
  }

  run<T>(
    operationClass: ProductOperationClass,
    operation: Operation<T>,
    options: ProductOperationOptions = {},
  ): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new ProductOperationSchedulerClosedError());
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new ProductOperationCancelledError(operationClass, "caller"),
      );
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
    ) {
      return Promise.reject(
        new RangeError("timeoutMs must be a positive finite number"),
      );
    }

    let pending!: PendingOperation<T>;
    const promise = new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const cancel = (reason: ProductOperationCancellationReason): void => {
        if (pending.settled) return;
        if (!pending.active && this.#cancelQueued(pending, reason)) return;
        controller.abort(reason);
        pending.settled = true;
        reject(new ProductOperationCancelledError(operationClass, reason));
      };
      const onCallerAbort = (): void => cancel("caller");
      options.signal?.addEventListener("abort", onCallerAbort, { once: true });
      if (options.timeoutMs !== undefined) {
        timeout = setTimeout(() => cancel("timeout"), options.timeoutMs);
      }
      const cleanup = (): void => {
        options.signal?.removeEventListener("abort", onCallerAbort);
        if (timeout !== undefined) clearTimeout(timeout);
        this.#unleased.delete(pending as PendingOperation);
      };
      pending = {
        operationClass,
        operation,
        controller,
        cleanup,
        resolve,
        reject,
        settled: false,
        active: false,
      };
    });

    const lane = this.#laneFor(operationClass);
    if (lane) lane.submit(pending);
    else this.#startUnleased(pending);
    return promise;
  }

  snapshot(): ProductOperationSchedulerSnapshot {
    return {
      closed: this.#closed,
      views: {
        active: this.#views.activeCount,
        queued: this.#views.queuedCount,
      },
      mutations: {
        active: this.#mutations.activeCount,
        queued: this.#mutations.queuedCount,
      },
      unleasedActive: this.#unleased.size,
    };
  }

  /** Stop admission and cancel queued and running operations. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#views.close();
    this.#mutations.close();
    for (const pending of this.#unleased) {
      pending.controller.abort("scheduler-closed");
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(
          new ProductOperationCancelledError(
            pending.operationClass,
            "scheduler-closed",
          ),
        );
      }
    }
  }

  #laneFor(operationClass: ProductOperationClass): OperationLane | undefined {
    switch (operationClass) {
      case "view-execution":
        return this.#views;
      case "workspace-mutation":
      case "engine-tick":
        return this.#mutations;
      case "immutable-adopted-read":
      case "operational-transaction":
      case "model-generation":
        return undefined;
    }
  }

  #cancelQueued<T>(
    pending: PendingOperation<T>,
    reason: ProductOperationCancellationReason,
  ): boolean {
    const lane = this.#laneFor(pending.operationClass);
    return lane?.cancelQueued(pending, reason) ?? false;
  }

  #startUnleased<T>(pending: PendingOperation<T>): void {
    pending.active = true;
    this.#unleased.add(pending as PendingOperation);
    void Promise.resolve()
      .then(() => pending.operation({ signal: pending.controller.signal }))
      .then(
        (value) => {
          if (!pending.settled) {
            pending.settled = true;
            pending.resolve(value);
          }
        },
        (error: unknown) => {
          if (!pending.settled) {
            pending.settled = true;
            pending.reject(error);
          }
        },
      )
      .finally(pending.cleanup);
  }
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return resolved;
}

function nonnegativeInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new RangeError(`${name} must be a nonnegative integer`);
  }
  return resolved;
}
