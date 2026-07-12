import { describe, expect, test } from "bun:test";
import {
  ProductOperationCancelledError,
  ProductOperationQueueFullError,
  ProductOperationScheduler,
  ProductOperationSchedulerClosedError,
} from "../../src/product-host/operation-scheduler";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function turn(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProductOperationScheduler", () => {
  test("adopted reads and generation run concurrently without leases", async () => {
    const scheduler = new ProductOperationScheduler();
    const release = deferred();
    const started: string[] = [];
    const read = scheduler.run("immutable-adopted-read", async () => { started.push("read"); await release.promise; });
    const model = scheduler.run("model-generation", async () => { started.push("model"); await release.promise; });
    await turn();
    expect(started).toEqual(["read", "model"]);
    expect(scheduler.snapshot().unleasedActive).toBe(2);
    release.resolve();
    await Promise.all([read, model]);
  });

  test("views, workspace mutations, and engine ticks share one FIFO lease", async () => {
    const scheduler = new ProductOperationScheduler();
    const releases = [deferred(), deferred(), deferred()];
    const order: number[] = [];
    const classes = ["view-execution", "workspace-mutation", "engine-tick"] as const;
    const runs = classes.map((kind, index) => scheduler.run(kind, async () => {
      order.push(index);
      await releases[index]!.promise;
    }));
    await turn();
    expect(order).toEqual([0]);
    expect(scheduler.snapshot().leased).toEqual({ active: 1, queued: 2 });
    for (let index = 0; index < releases.length; index += 1) {
      releases[index]!.resolve();
      await runs[index];
      await turn();
    }
    expect(order).toEqual([0, 1, 2]);
  });

  test("queue overload carries a retry hint", async () => {
    const scheduler = new ProductOperationScheduler({ maxQueuedLeasedOperations: 1, retryAfterMs: 2_500 });
    const firstGate = deferred();
    const secondGate = deferred();
    const first = scheduler.run("view-execution", () => firstGate.promise);
    const second = scheduler.run("engine-tick", () => secondGate.promise);
    const error = await scheduler.run("workspace-mutation", async () => {}).catch((reason) => reason);
    expect(error).toBeInstanceOf(ProductOperationQueueFullError);
    expect(error).toMatchObject({ retryAfterMs: 2_500 });
    firstGate.resolve(); await first;
    secondGate.resolve(); await second;
  });

  test("queued cancellation preserves FIFO", async () => {
    const scheduler = new ProductOperationScheduler();
    const gate = deferred();
    const controller = new AbortController();
    const first = scheduler.run("view-execution", () => gate.promise);
    const cancelled = scheduler.run("engine-tick", async () => {}, { signal: controller.signal });
    controller.abort();
    expect(await cancelled.catch((reason) => reason)).toBeInstanceOf(ProductOperationCancelledError);
    gate.resolve(); await first;
  });

  test("timeout retains the lease until underlying cleanup and idle", async () => {
    const scheduler = new ProductOperationScheduler();
    const cleanup = deferred();
    const timedOut = scheduler.run("workspace-mutation", async ({ signal }) => {
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      await cleanup.promise;
    }, { timeoutMs: 5 });
    expect(await timedOut.catch((reason) => reason)).toMatchObject({ reason: "timeout" });
    let idle = false;
    const waiting = scheduler.whenIdle().then(() => { idle = true; });
    await turn();
    expect(idle).toBe(false);
    cleanup.resolve();
    await waiting;
    expect(idle).toBe(true);
  });

  test("close aborts work, awaits leased cleanup, and refuses admission", async () => {
    const scheduler = new ProductOperationScheduler();
    const cleaned = deferred();
    const running = scheduler.run("engine-tick", async ({ signal }) => {
      await new Promise<void>((done) => signal.addEventListener("abort", () => done(), { once: true }));
      await cleaned.promise;
    });
    await turn();
    scheduler.close();
    expect(await running.catch((reason) => reason)).toMatchObject({ reason: "scheduler-closed" });
    const idle = scheduler.whenIdle();
    cleaned.resolve();
    await idle;
    expect(await scheduler.run("immutable-adopted-read", async () => {}).catch((reason) => reason))
      .toBeInstanceOf(ProductOperationSchedulerClosedError);
  });
});
