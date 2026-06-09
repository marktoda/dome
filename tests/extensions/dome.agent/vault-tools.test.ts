import { describe, expect, test } from "bun:test";
import { deletePageTool, readPageTool } from "../../../assets/extensions/dome.agent/lib/vault-tools";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}
const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

describe("deletePageTool", () => {
  test("accumulates a delete edit", async () => {
    const t = deletePageTool();
    const state = freshState();
    await t.execute({ path: "wiki/concepts/dupe.md" }, state);
    expect(state.edits.get("wiki/concepts/dupe.md")).toEqual({
      kind: "delete",
      path: "wiki/concepts/dupe.md",
    });
  });

  test("a deleted page reads back as absent within the run", async () => {
    const del = deletePageTool();
    const read = readPageTool(reader({ "wiki/concepts/dupe.md": "old" }));
    const state = freshState();
    await del.execute({ path: "wiki/concepts/dupe.md" }, state);
    const out = await read.execute({ path: "wiki/concepts/dupe.md" }, state);
    expect(out).toContain("(no file at");
  });
});
