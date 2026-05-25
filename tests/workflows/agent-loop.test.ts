import { describe, test, expect } from "bun:test";
import { AgentLoop, type LlmClient, type LlmTurn } from "../../src/workflows/agent-loop";
import { openVault } from "../../src/vault";
import { makeTestVault } from "../helpers/make-test-vault";
import { WorkflowName } from "../../src/workflows/workflow-name";

class StubClient implements LlmClient {
  public turns: { systemPrompt: string; toolNames: ReadonlyArray<string> }[] = [];

  async next(input: {
    systemPrompt: string;
    toolNames: ReadonlyArray<string>;
  }): Promise<LlmTurn> {
    this.turns.push({ systemPrompt: input.systemPrompt, toolNames: input.toolNames });
    return { kind: "stop", reason: "end_turn" };
  }
}

describe("AgentLoop", () => {
  test("loads workflow prompt and binds the declared tool subset", async () => {
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const stub = new StubClient();
      const loop = new AgentLoop(res.value, stub);
      await loop.runWorkflow(WorkflowName.Query, "What do I know about Atlas?");
      expect(stub.turns.length).toBe(1);
      // query workflow binds: readDocument, searchIndex, wikilinkResolve, writeDocument
      expect([...stub.turns[0]!.toolNames].sort()).toEqual(
        ["readDocument", "searchIndex", "wikilinkResolve", "writeDocument"].sort()
      );
      expect(stub.turns[0]!.systemPrompt).toContain("Query");
    } finally {
      await v.cleanup();
    }
  });

  test("runs until LLM signals stop", async () => {
    let calls = 0;
    const stub: LlmClient = {
      async next() {
        calls++;
        if (calls < 3) return { kind: "continue" };
        return { kind: "stop", reason: "end_turn" };
      },
    };
    const v = await makeTestVault();
    try {
      const res = await openVault(v.path);
      if (!res.ok) return;
      const loop = new AgentLoop(res.value, stub);
      await loop.runWorkflow(WorkflowName.ExportContext, "platform team ownership");
      expect(calls).toBe(3);
    } finally {
      await v.cleanup();
    }
  });
});
