import { describe, expect, test } from "bun:test";
import { makeConsolidatorTools } from "../../../assets/extensions/dome.agent/lib/consolidate-tools";
import type { AgentRunState } from "../../../assets/extensions/dome.agent/lib/agent-loop";

const reader = (files: Record<string, string> = {}) => ({
  readFile: async (p: string) => files[p] ?? null,
  listMarkdownFiles: async () => Object.keys(files),
});

function freshState(): AgentRunState {
  return { edits: new Map(), questions: [] };
}

describe("makeConsolidatorTools", () => {
  test("provides the consolidator tool set incl. deletePage, excl. inbox tools", async () => {
    const names = makeConsolidatorTools({
      reader: reader(),
      ledgerPath: "consolidation-ledger.md",
    })
      .map((t) => t.schema.name)
      .sort();
    expect(names).toEqual([
      "askOwner",
      "deletePage",
      "listPages",
      "readPage",
      "searchVault",
      "writePage",
    ]);
  });
});

describe("consolidate signals-page append-only guard", () => {
  const EXISTING = [
    "- 2026-06-01 + filing:: notes go under notes/",
    "- 2026-06-02 - filing:: rejected by owner",
  ].join("\n");

  function tools(files: Record<string, string> = {}) {
    return makeConsolidatorTools({
      reader: reader(files),
      ledgerPath: "consolidation-ledger.md",
    });
  }

  test("deletePage refuses to delete the signals page (owner tombstones)", async () => {
    const t = tools({ "preferences/signals.md": EXISTING }).find(
      (x) => x.schema.name === "deletePage",
    )!;
    const state = freshState();
    const out = await t.execute({ path: "preferences/signals.md" }, state);
    expect(out).toContain("append-only");
    expect(out).toContain("cannot be deleted");
    expect(state.edits.has("preferences/signals.md")).toBe(false);
  });

  test("writePage rejects a rewrite of the signals page", async () => {
    const t = tools({ "preferences/signals.md": EXISTING }).find(
      (x) => x.schema.name === "writePage",
    )!;
    const state = freshState();
    const out = await t.execute(
      { path: "preferences/signals.md", content: "consolidated away" },
      state,
    );
    expect(out).toContain("append-only");
    expect(state.edits.has("preferences/signals.md")).toBe(false);
  });

  test("writePage accepts an append of well-formed signal lines", async () => {
    const t = tools({ "preferences/signals.md": EXISTING }).find(
      (x) => x.schema.name === "writePage",
    )!;
    const state = freshState();
    const out = await t.execute(
      {
        path: "preferences/signals.md",
        content: `${EXISTING}\n- 2026-06-09 + naming:: kebab-case slugs\n`,
      },
      state,
    );
    expect(out).toBe("wrote preferences/signals.md");
    expect(state.edits.get("preferences/signals.md")?.kind).toBe("write");
  });

  test("other pages stay deletable and rewritable", async () => {
    const set = tools({ "wiki/dup.md": "duplicate" });
    const del = set.find((x) => x.schema.name === "deletePage")!;
    const state = freshState();
    expect(await del.execute({ path: "wiki/dup.md" }, state)).toBe(
      "deleted wiki/dup.md",
    );
  });
});
