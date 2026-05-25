import { describe, test, expect } from "bun:test";
import { parseWorkflowFrontmatter, isWorkflowPrompt } from "../../src/prompts/workflow-frontmatter";

describe("workflow frontmatter", () => {
  test("parses valid workflow frontmatter", () => {
    const fm = {
      type: "workflow-prompt",
      name: "ingest",
      tools: ["readDocument", "writeDocument", "appendLog"],
      triggers: ["intake:inbox/raw/*", "intent:capture-thought"],
      description: "Process a raw source.",
    };
    const result = parseWorkflowFrontmatter(fm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("ingest");
      expect(result.value.tools.length).toBe(3);
    }
  });

  test("rejects non-workflow frontmatter (type missing)", () => {
    const result = parseWorkflowFrontmatter({ name: "ingest" });
    expect(result.ok).toBe(false);
  });

  test("isWorkflowPrompt: returns true only when type === 'workflow-prompt'", () => {
    expect(isWorkflowPrompt({ type: "workflow-prompt", name: "x" })).toBe(true);
    expect(isWorkflowPrompt({ type: "spec" })).toBe(false);
  });
});
