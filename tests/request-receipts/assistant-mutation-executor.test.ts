import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProductOperationScheduler } from "../../src/product-host/operation-scheduler";
import { openRequestReceiptsDb } from "../../src/request-receipts/db";
import {
  AssistantMutationAdmissionError,
  AssistantMutationOutcomeUnknownError,
  createAssistantMutationExecutor,
  type AuthenticatedMutationActor,
} from "../../src/request-receipts/assistant-mutation-executor";
import { createRequestReceipts } from "../../src/request-receipts/request-receipts";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const ACTOR: AuthenticatedMutationActor = Object.freeze({
  requestId: "turn-request", actorId: "owner", deviceId: "device-1",
  credentialId: "credential-1", transport: "cookie",
});

async function store(ids: string[]) {
  const root = mkdtempSync(join(tmpdir(), "dome-assistant-receipts-"));
  roots.push(root);
  const opened = await openRequestReceiptsDb({ path: join(root, "receipts.db") });
  if (!opened.ok) throw new Error(opened.error.kind);
  const receipts = createRequestReceipts(opened.value.db, { createId: () => ids.shift()! });
  return receipts;
}

describe("assistant mutation executor", () => {
  test("distinct children share turn identity and borrow the requested scheduler lanes", async () => {
    const receipts = await store(["child-1", "child-2"]);
    const scheduler = new ProductOperationScheduler();
    const lanes: string[] = [];
    const adapter = {
      run: <T>(lane: Parameters<ProductOperationScheduler["run"]>[0], op: Parameters<ProductOperationScheduler["run"]>[1], options?: Parameters<ProductOperationScheduler["run"]>[2]) => {
        lanes.push(lane);
        return scheduler.run(lane, op as never, options) as Promise<T>;
      },
    };
    const executor = createAssistantMutationExecutor({ receipts, hostInstanceId: "host-1", scheduler: adapter });
    await executor.execute({ actor: ACTOR, operation: "capture", operationClass: "workspace-mutation", mutate: async () => ({ value: 1, terminal: { state: "succeeded", resultCode: "captured", commitOid: "a".repeat(40) } }) });
    await executor.execute({ actor: ACTOR, operation: "resolve", operationClass: "operational-transaction", mutate: async () => ({ value: 2, terminal: { state: "succeeded", resultCode: "answered" } }) });
    expect(lanes).toEqual(["workspace-mutation", "operational-transaction"]);
    const rows = receipts.list({ requestId: ACTOR.requestId });
    expect(new Set(rows.map((row) => row.operationId))).toEqual(new Set(["child-1", "child-2"]));
    expect(rows.every((row) => row.executor === "assistant" && row.deviceId === ACTOR.deviceId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("prompt");
    receipts.close();
  });

  test("admission failure prevents mutation", async () => {
    let mutated = false;
    const executor = createAssistantMutationExecutor({
      receipts: { admit: () => { throw new Error("disk full"); } },
      hostInstanceId: "host-1",
      scheduler: new ProductOperationScheduler(),
    });
    await expect(executor.execute({ actor: ACTOR, operation: "capture", operationClass: "workspace-mutation", mutate: async () => { mutated = true; return { value: 1, terminal: { state: "succeeded", resultCode: "captured" } }; } }))
      .rejects.toBeInstanceOf(AssistantMutationAdmissionError);
    expect(mutated).toBe(false);
  });

  test("a possible side effect followed by throw persists interrupted uncertainty", async () => {
    const receipts = await store(["child-unknown"]);
    const executor = createAssistantMutationExecutor({ receipts, hostInstanceId: "host-1", scheduler: new ProductOperationScheduler() });
    let sideEffect = false;
    await expect(executor.execute({ actor: ACTOR, operation: "edit-document", operationClass: "workspace-mutation", mutate: async () => { sideEffect = true; throw new Error("lost response"); } }))
      .rejects.toBeInstanceOf(AssistantMutationOutcomeUnknownError);
    expect(sideEffect).toBe(true);
    expect(receipts.list()).toEqual([expect.objectContaining({ state: "interrupted", adoptionState: "unknown", recoveryRequired: true })]);
    receipts.close();
  });

  test("a queued cancelled child never admits or mutates", async () => {
    const receipts = await store(["active-child", "must-not-admit"]);
    const scheduler = new ProductOperationScheduler();
    const executor = createAssistantMutationExecutor({ receipts, hostInstanceId: "host-1", scheduler });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = executor.execute({
      actor: ACTOR, operation: "capture", operationClass: "workspace-mutation",
      mutate: async () => { await blocked; return { value: 1, terminal: { state: "succeeded", resultCode: "captured" } }; },
    });
    while (receipts.list().length === 0) await Promise.resolve();
    let mutated = false;
    const controller = new AbortController();
    const queued = executor.execute({
      actor: ACTOR, operation: "settle", operationClass: "workspace-mutation", signal: controller.signal,
      mutate: async () => { mutated = true; return { value: 2, terminal: { state: "succeeded", resultCode: "settled" } }; },
    });
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled");
    expect(mutated).toBe(false);
    expect(receipts.list()).toHaveLength(1);
    release();
    await active;
    receipts.close();
  });

  test("active cancellation rejects the caller but the callback finalizes eventual truth", async () => {
    const receipts = await store(["active-cancelled-caller"]);
    const scheduler = new ProductOperationScheduler();
    const executor = createAssistantMutationExecutor({ receipts, hostInstanceId: "host-1", scheduler });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const running = executor.execute({
      actor: ACTOR,
      operation: "capture",
      operationClass: "workspace-mutation",
      signal: controller.signal,
      mutate: async () => {
        await blocked; // deliberately ignores cancellation: a commit may already be in flight
        return { value: 1, terminal: { state: "succeeded", resultCode: "captured" } };
      },
    });
    while (receipts.list().length === 0) await Promise.resolve();
    controller.abort();
    await expect(running).rejects.toThrow("cancelled");
    expect(receipts.list()).toEqual([expect.objectContaining({ state: "admitted" })]);
    release();
    await scheduler.whenIdle();
    expect(receipts.list()).toEqual([expect.objectContaining({
      state: "succeeded",
      resultCode: "captured",
      recoveryRequired: false,
    })]);
    receipts.close();
  });
});
