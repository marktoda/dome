import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentWriteReceiptTerminal, buildAgentTools } from "../../src/assistant/tools";
import { runInit } from "../../src/cli/commands/init";
import { ProductOperationScheduler } from "../../src/product-host/operation-scheduler";
import { createAssistantMutationExecutor, type AuthenticatedMutationActor } from "../../src/request-receipts/assistant-mutation-executor";
import { openRequestReceiptsDb } from "../../src/request-receipts/db";
import { createRequestReceipts } from "../../src/request-receipts/request-receipts";
import { openVault } from "../../src/vault";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const actor: AuthenticatedMutationActor = {
  requestId: "turn-request", actorId: "owner", deviceId: "device-1",
  credentialId: "credential-1", transport: "cookie",
};

describe("assistant tool child receipts", () => {
  test("a landed author commit with checkout divergence is successful recovery-required truth", () => {
    const commit = "a".repeat(40);
    expect(agentWriteReceiptTerminal({ kind: "interrupted", commit, message: "checkout recovery required" }))
      .toEqual({ state: "succeeded", resultCode: "committed-recovery-required", commitOid: commit, recoveryRequired: true });
  });
  test("capture, create/edit, and resolve rejection record exact child truth while reads record nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "dome-agent-tool-receipts-"));
    roots.push(root);
    const originalLog = console.log;
    console.log = () => {};
    try { expect(await runInit({ path: root })).toBe(0); } finally { console.log = originalLog; }
    const openedVault = await openVault({ path: root });
    if (!openedVault.ok) throw new Error(openedVault.error.kind);
    const receiptPath = join(root, ".dome", "state", "tool-receipts.db");
    const openedDb = await openRequestReceiptsDb({ path: receiptPath });
    if (!openedDb.ok) throw new Error(openedDb.error.kind);
    let id = 0;
    const receipts = createRequestReceipts(openedDb.value.db, { createId: () => `child-${++id}` });
    const executor = createAssistantMutationExecutor({ receipts, hostInstanceId: "host-1", scheduler: new ProductOperationScheduler() });
    const tools = buildAgentTools(openedVault.value, [], {
      vaultPath: root, modelId: "test-model", changes: [],
      capabilities: new Set(["read", "capture", "resolve", "author"]),
      mutationActor: actor, mutationExecutor: executor,
    });
    const call = async (name: string, input: unknown) => (tools[name] as { execute: (input: unknown) => Promise<unknown> }).execute(input);
    const privateStrings = [
      "private owner prompt token",
      "private capture prose token",
      "private-old-content-token",
      "private-new-content-token",
      "wiki/private-path-token.md",
    ];
    await call("capture_note", { text: privateStrings[1] });
    await call("create_document", { path: privateStrings[4], content: privateStrings[2] });
    await call("edit_document", { path: privateStrings[4], old_string: privateStrings[2], new_string: privateStrings[3] });
    await call("resolve_question", { id: 999999, value: "yes" });
    await call("settle_task", { blockId: "tmissing", disposition: "keep" });
    await call("complete_agent_work", { questionId: 999999, expectedRevision: "r1", answer: "yes", reason: "tested" });
    await call("apply_proposal", { id: 999999 });
    await call("reject_proposal", { id: 999999 });
    const beforeRead = receipts.list().length;
    await call("read_document", { path: "index.md" });
    expect(receipts.list()).toHaveLength(beforeRead);
    const rows = receipts.list({ requestId: actor.requestId });
    expect(rows.map((row) => row.operation)).toEqual(expect.arrayContaining([
      "capture", "create-document", "edit-document", "resolve", "settle",
      "agent-work-complete", "apply-proposal", "reject-proposal",
    ]));
    expect(rows.filter((row) => ["capture", "create-document", "edit-document"].includes(row.operation))
      .every((row) => row.state === "succeeded" && row.commitOid !== null)).toBe(true);
    expect(rows.find((row) => row.operation === "resolve")).toMatchObject({ state: "rejected", resultCode: "not-found" });
    expect(new Set(rows.map((row) => row.operationId)).size).toBe(8);
    expect(JSON.stringify(rows)).not.toContain("private");
    receipts.close();
    await openedVault.value.close();
    for (const file of [receiptPath, `${receiptPath}-wal`, `${receiptPath}-shm`]) {
      if (!existsSync(file)) continue;
      const bytes = await readFile(file);
      for (const secret of privateStrings) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    }
  }, 30_000);

  test("an incomplete actor/executor pair fails before mutation", async () => {
    let captured = false;
    const vault = {
      path: "/tmp/unused", listViews: () => [],
      readDocument: async () => null, runView: async () => null,
    } as never;
    const tools = buildAgentTools(vault, [], {
      vaultPath: "/tmp/unused", modelId: "m", changes: [], capabilities: new Set(["capture"]),
      mutationActor: actor,
    });
    await expect((tools.capture_note as { execute: (input: unknown) => Promise<unknown> }).execute({
      text: "must not mutate",
      get title() { captured = true; return undefined; },
    })).rejects.toThrow("pair is incomplete");
    expect(captured).toBe(false);
  });
});
