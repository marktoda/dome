/** Product Host operation admission; independent of HTTP and Vault. */

export type ProductOperationClass =
  | "immutable-adopted-read"
  | "view-execution"
  | "operational-transaction"
  | "workspace-mutation"
  | "engine-tick"
  | "model-generation";

export type ProductOperationContext = { readonly signal: AbortSignal };
export type ProductOperationOptions = {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};
export type ProductOperationSchedulerOptions = {
  /** Waiting runtime-touching operations, excluding the active operation. */
  readonly maxQueuedLeasedOperations?: number;
  readonly retryAfterMs?: number;
};
export type ProductOperationSchedulerSnapshot = {
  readonly closed: boolean;
  readonly leased: { readonly active: number; readonly queued: number };
  readonly unleasedActive: number;
};
export type ProductOperationCancellationReason = "caller" | "timeout" | "scheduler-closed";

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
type Pending<T = unknown> = {
  readonly operationClass: ProductOperationClass;
  readonly operation: Operation<T>;
  readonly controller: AbortController;
  readonly cleanup: () => void;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  settled: boolean;
  active: boolean;
};

const DEFAULT_MAX_QUEUED = 32;
const DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * The initial Product Host posture is deliberately conservative: views,
 * workspace mutations, and compiler ticks share one bounded FIFO lease because
 * they touch the same runtime databases. Immutable adopted reads, store-owned
 * transactions, and generation are concurrent and hold no host-wide lease.
 */
export class ProductOperationScheduler {
  readonly #queue: Pending[] = [];
  readonly #activeUnleased = new Set<Pending>();
  readonly #maxQueued: number;
  readonly #retryAfterMs: number;
  #activeLeased: Pending | null = null;
  #closed = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: ProductOperationSchedulerOptions = {}) {
    this.#maxQueued = nonnegativeInteger(
      options.maxQueuedLeasedOperations,
      DEFAULT_MAX_QUEUED,
      "maxQueuedLeasedOperations",
    );
    this.#retryAfterMs = positiveInteger(options.retryAfterMs, DEFAULT_RETRY_AFTER_MS, "retryAfterMs");
  }

  run<T>(
    operationClass: ProductOperationClass,
    operation: Operation<T>,
    options: ProductOperationOptions = {},
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new ProductOperationSchedulerClosedError());
    if (options.signal?.aborted === true) {
      return Promise.reject(new ProductOperationCancelledError(operationClass, "caller"));
    }
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
      return Promise.reject(new RangeError("timeoutMs must be a positive finite number"));
    }

    let pending!: Pending<T>;
    const promise = new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cancel = (reason: ProductOperationCancellationReason): void => {
        if (pending.settled) return;
        if (!pending.active && this.#removeQueued(pending as Pending)) {
          pending.cleanup();
          pending.settled = true;
          reject(new ProductOperationCancelledError(operationClass, reason));
          this.#notifyIdle();
          return;
        }
        controller.abort(reason);
        pending.settled = true;
        reject(new ProductOperationCancelledError(operationClass, reason));
      };
      const onAbort = (): void => cancel("caller");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.timeoutMs !== undefined) timeout = setTimeout(() => cancel("timeout"), options.timeoutMs);
      pending = {
        operationClass,
        operation,
        controller,
        resolve,
        reject,
        settled: false,
        active: false,
        cleanup: () => {
          options.signal?.removeEventListener("abort", onAbort);
          if (timeout !== undefined) clearTimeout(timeout);
          this.#activeUnleased.delete(pending as Pending);
        },
      };
    });

    if (isLeased(operationClass)) this.#submitLeased(pending);
    else this.#startUnleased(pending);
    return promise;
  }

  snapshot(): ProductOperationSchedulerSnapshot {
    return {
      closed: this.#closed,
      leased: { active: this.#activeLeased === null ? 0 : 1, queued: this.#queue.length },
      unleasedActive: this.#activeUnleased.size,
    };
  }

  /** Resolves only after every underlying admitted operation has returned. */
  whenIdle(): Promise<void> {
    if (this.#activeLeased === null && this.#queue.length === 0 && this.#activeUnleased.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Stop admission and abort queued/running work. Idempotent. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#queue.splice(0)) {
      pending.cleanup();
      pending.settled = true;
      pending.reject(new ProductOperationCancelledError(pending.operationClass, "scheduler-closed"));
    }
    this.#abortPending(this.#activeLeased);
    for (const pending of this.#activeUnleased) this.#abortPending(pending);
    this.#notifyIdle();
  }

  #submitLeased<T>(pending: Pending<T>): void {
    if (this.#activeLeased === null) this.#startLeased(pending as Pending);
    else if (this.#queue.length >= this.#maxQueued) {
      pending.cleanup();
      pending.settled = true;
      pending.reject(new ProductOperationQueueFullError(pending.operationClass, this.#retryAfterMs));
    } else this.#queue.push(pending as Pending);
  }

  #startLeased(pending: Pending): void {
    pending.active = true;
    this.#activeLeased = pending;
    this.#execute(pending).finally(() => {
      this.#activeLeased = null;
      const next = this.#queue.shift();
      if (next !== undefined) this.#startLeased(next);
      else this.#notifyIdle();
    });
  }

  #startUnleased<T>(pending: Pending<T>): void {
    pending.active = true;
    this.#activeUnleased.add(pending as Pending);
    this.#execute(pending as Pending).finally(() => this.#notifyIdle());
  }

  async #execute(pending: Pending): Promise<void> {
    try {
      const value = await pending.operation({ signal: pending.controller.signal });
      if (!pending.settled) {
        pending.settled = true;
        pending.resolve(value);
      }
    } catch (error) {
      if (!pending.settled) {
        pending.settled = true;
        pending.reject(error);
      }
    } finally {
      pending.cleanup();
    }
  }

  #abortPending(pending: Pending | null): void {
    if (pending === null) return;
    pending.controller.abort("scheduler-closed");
    if (!pending.settled) {
      pending.settled = true;
      pending.reject(new ProductOperationCancelledError(pending.operationClass, "scheduler-closed"));
    }
  }

  #removeQueued(pending: Pending): boolean {
    const index = this.#queue.indexOf(pending);
    if (index < 0) return false;
    this.#queue.splice(index, 1);
    return true;
  }

  #notifyIdle(): void {
    if (this.#activeLeased !== null || this.#queue.length > 0 || this.#activeUnleased.size > 0) return;
    for (const resolve of this.#idleWaiters.splice(0)) resolve();
  }
}

function isLeased(operationClass: ProductOperationClass): boolean {
  return operationClass === "view-execution" ||
    operationClass === "workspace-mutation" ||
    operationClass === "engine-tick";
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) throw new RangeError(`${name} must be a positive integer`);
  return resolved;
}

function nonnegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) throw new RangeError(`${name} must be a nonnegative integer`);
  return resolved;
}
