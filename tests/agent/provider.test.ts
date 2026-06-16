import { describe, expect, test } from "bun:test";
import { askStepFromProvider } from "../../src/agent/provider";

describe("askStepFromProvider", () => {
  test("adapts a ModelStepProvider into an AskStepFn (forwards messages/tools, returns text+toolCalls)", async () => {
    const fakeProvider = async (req: { messages: unknown; tools: unknown; signal: AbortSignal; model?: string }) => {
      expect(req.signal).toBeInstanceOf(AbortSignal);
      return { text: "hi", toolCalls: [{ id: "1", name: "search_vault", input: { text: "x" } }] };
    };
    const step = askStepFromProvider(fakeProvider as never, { model: "claude-opus-4-1", signal: new AbortController().signal });
    const out = await step({ messages: [{ role: "user", content: "q" }] as never, tools: [] });
    expect(out.text).toBe("hi");
    expect(out.toolCalls?.[0]?.name).toBe("search_vault");
  });
});
