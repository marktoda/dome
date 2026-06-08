import { describe, expect, test } from "bun:test";
import { makeIngestTools } from "../../../assets/extensions/dome.agent/lib/ingest-tools";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}

const reader = (files: Record<string, string>) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

describe("ingest tools", () => {
  test("writePage accumulates a write edit", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "writePage")!;
    const state = freshState();
    await t.execute({ path: "wiki/sources/a.md", content: "hi" }, state);
    expect(state.edits.get("wiki/sources/a.md")).toEqual({
      kind: "write", path: "wiki/sources/a.md", content: "hi",
    });
  });

  test("appendToPage appends to current snapshot content", async () => {
    const tools = makeIngestTools({ reader: reader({ "log.md": "line1" }) });
    const t = tools.find((x) => x.schema.name === "appendToPage")!;
    const state = freshState();
    await t.execute({ path: "log.md", content: "line2" }, state);
    const edit = state.edits.get("log.md");
    expect(edit?.kind === "write" && edit.content).toBe("line1\nline2");
  });

  test("archiveSource deletes the raw path and writes a processed copy", async () => {
    const tools = makeIngestTools({ reader: reader({ "inbox/raw/x.md": "body" }) });
    const t = tools.find((x) => x.schema.name === "archiveSource")!;
    const state = freshState();
    await t.execute({ rawPath: "inbox/raw/x.md" }, state);
    expect(state.edits.get("inbox/raw/x.md")).toEqual({
      kind: "delete", path: "inbox/raw/x.md",
    });
    const processed = state.edits.get("inbox/processed/x.md");
    expect(processed?.kind).toBe("write");
  });

  test("askOwner records a question", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "askOwner")!;
    const state = freshState();
    await t.execute({ question: "is X true?" }, state);
    expect(state.questions[0]?.question).toBe("is X true?");
  });
});
