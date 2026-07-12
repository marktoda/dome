import { describe, expect, test } from "bun:test";
import {
  ProductOperationCancelledError,
  ProductOperationQueueFullError,
  ProductOperationScheduler,
  ProductOperationSchedulerClosedError,
  type ProductOperationClass,
} from "../../src/product-host/operation-scheduler";

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProductOperationScheduler", () => {
  test("immutable reads and model generations run concurrently without leases", async () => {
    const scheduler = new ProductOperationScheduler();
    const release = deferred();
    const started: ProductOperationClass[] = [];

    const read = scheduler.run("immutable-adopted-read", async () => {
      started.push("immutable-adopted-read");
      await release.promise;
    });
    const generation = scheduler.run("model-generation", async () => {
      started.push("model-generation");
      await release.promise;
    });
    await turn();

    expect(started).toEqual(["immutable-adopted-read", "model-generation"]);
    expect(scheduler.snapshot().unleasedActive).toBe(2);
    release.resolve();
    await Promise.all([read, generation]);
  });

  test("view execution uses a bounded concurrent lease", async () => {
    const scheduler = new ProductOperationScheduler({
      maxConcurrentViews: 2,
      maxQueuedViews: 1,
    });
    const releases = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    const runs = releases.map((release, index) =>
      scheduler.run("view-execution", async () => {
        started.push(index);
        await release.promise;
      }),
    );
    await turn();

    expect(started).toEqual([0, 1]);
    expect(scheduler.snapshot().views).toEqual({ active: 2, queued: 1 });
    releases[0]!.resolve();
    await runs[0];
    await turn();
    expect(started).toEqual([0, 1, 2]);
    releases[1]!.resolve();
    releases[2]!.resolve();
    await Promise.all(runs);
  });

  test("workspace mutations and engine ticks share one FIFO lane", async () => {
    const scheduler = new ProductOperationScheduler();
    const releases = [deferred(), deferred(), deferred()];
    const order: string[] = [];
    const classes = [
      "workspace-mutation",
      "engine-tick",
      "workspace-mutation",
    ] as const;
    const runs = classes.map((operationClass, index) =>
      scheduler.run(operationClass, async () => {
        order.push(`start-${index}`);
        await releases[index]!.promise;
        order.push(`end-${index}`);
      }),
    );
    await turn();
    expect(order).toEqual(["start-0"]);

    for (let index = 0; index < releases.length; index += 1) {
      releases[index]!.resolve();
      await runs[index];
      await turn();
    }
    expect(order).toEqual([
      "start-0",
      "end-0",
      "start-1",
      "end-1",
      "start-2",
      "end-2",
    ]);
  });

  test("queue overload is a typed error with a retry hint", async () => {
    const scheduler = new ProductOperationScheduler({
      maxQueuedMutations: 1,
      retryAfterMs: 2_500,
    });
    const active = deferred();
    const queued = deferred();
    const first = scheduler.run("workspace-mutation", () => active.promise);
    const second = scheduler.run("engine-tick", () => queued.promise);
    const rejected = scheduler.run("workspace-mutation", async () => {});

    const error = await rejected.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProductOperationQueueFullError);
    expect(error).toMatchObject({
      code: "operation-queue-full",
      operationClass: "workspace-mutation",
      retryAfterMs: 2_500,
    });
    active.resolve();
    await first;
    queued.resolve();
    await second;
  });

  test("a queued caller can cancel without disturbing FIFO", async () => {
    const scheduler = new ProductOperationScheduler();
    const active = deferred();
    const tail = deferred();
    const controller = new AbortController();
    const started: string[] = [];
    const first = scheduler.run("workspace-mutation", async () => {
      started.push("first");
      await active.promise;
    });
    const cancelled = scheduler.run(
      "engine-tick",
      async () => {
        started.push("cancelled");
      },
      { signal: controller.signal },
    );
    const last = scheduler.run("workspace-mutation", async () => {
      started.push("last");
      await tail.promise;
    });
    await turn();
    controller.abort();

    const error = await cancelled.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ProductOperationCancelledError);
    expect(error).toMatchObject({ reason: "caller" });
    active.resolve();
    await first;
    await turn();
    expect(started).toEqual(["first", "last"]);
    tail.resolve();
    await last;
  });

  test("timeout aborts a running task but retains its lane until task cleanup", async () => {
    const scheduler = new ProductOperationScheduler();
    const cleanup = deferred();
    let observedAbort = false;
    let secondStarted = false;
    const timedOut = scheduler.run(
      "workspace-mutation",
      async ({ signal }) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve();
            },
            { once: true },
          );
        });
        await cleanup.promise;
      },
      { timeoutMs: 5 },
    );
    const second = scheduler.run("engine-tick", async () => {
      secondStarted = true;
    });

    const error = await timedOut.catch((reason: unknown) => reason);
    expect(error).toMatchObject({ reason: "timeout" });
    expect(observedAbort).toBe(true);
    expect(secondStarted).toBe(false);
    cleanup.resolve();
    await second;
    expect(secondStarted).toBe(true);
  });

  test("close cancels work and refuses new admission", async () => {
    const scheduler = new ProductOperationScheduler();
    let runningSignal: AbortSignal | undefined;
    const running = scheduler.run("model-generation", async ({ signal }) => {
      runningSignal = signal;
      await new Promise<void>(() => {});
    });
    await turn();
    scheduler.close();

    expect(await running.catch((reason: unknown) => reason)).toMatchObject({
      reason: "scheduler-closed",
    });
    expect(runningSignal?.aborted).toBe(true);
    expect(
      await scheduler
        .run("immutable-adopted-read", async () => {})
        .catch((reason: unknown) => reason),
    ).toBeInstanceOf(ProductOperationSchedulerClosedError);
  });
});
