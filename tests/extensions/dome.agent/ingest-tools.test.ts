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

  test("listPages and searchVault overlay pages written earlier in the same run", async () => {
    const tools = makeIngestTools({ reader: reader({ "wiki/existing.md": "old" }) });
    const state = freshState();
    // an earlier source wrote a new page into the shared accumulator
    state.edits.set("wiki/new.md", {
      kind: "write",
      path: "wiki/new.md",
      content: "fresh notes about pandas",
    });
    const list = await tools.find((x) => x.schema.name === "listPages")!.execute({}, state);
    expect(list).toContain("wiki/new.md");
    const search = await tools
      .find((x) => x.schema.name === "searchVault")!
      .execute({ query: "pandas" }, state);
    expect(search).toContain("wiki/new.md");
  });

  test("readPage truncates a very large page to bound context", async () => {
    const huge = "y".repeat(50_000);
    const tools = makeIngestTools({ reader: reader({ "wiki/big.md": huge }) });
    const t = tools.find((x) => x.schema.name === "readPage")!;
    const out = await t.execute({ path: "wiki/big.md" }, freshState());
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("[truncated");
  });

  test("askOwner records a question", async () => {
    const tools = makeIngestTools({ reader: reader({}) });
    const t = tools.find((x) => x.schema.name === "askOwner")!;
    const state = freshState();
    await t.execute({ question: "is X true?" }, state);
    expect(state.questions[0]?.question).toBe("is X true?");
  });
});
