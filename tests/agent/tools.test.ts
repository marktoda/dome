import { describe, expect, test } from "bun:test";
import { buildAskTools } from "../../src/agent/tools";
import type { AskState } from "../../src/agent/types";

// Real VaultViewResult shape: {kind: "ok", structured: {name, schema, data}, views, brokerDiagnostics}
// Real query structured.data shape (dome.search.query/v1):
//   {matches: [{path, title, snippet, sourceRefs: [{path, commit, ...}], ...}]}
// Note: sourceRefs is an array (plural), NOT a single sourceRef object.

function fakeVault(over: Partial<{ runView: unknown; readDocument: unknown }> = {}) {
  return {
    runView:
      over.runView ??
      (async (_cmd: string, _args: unknown) => ({
        kind: "ok",
        views: [],
        brokerDiagnostics: [],
        structured: {
          name: "dome.search.query",
          schema: "dome.search.query/v1",
          data: {
            schema: "dome.search.query/v1",
            query: "robinhood",
            matches: [
              {
                path: "wiki/entities/robinhood-chain.md",
                title: "Robinhood Chain",
                snippet: "launches ~early July 2026",
                category: "wiki",
                type: null,
                sectionId: null,
                breadcrumb: null,
                rank: 1,
                sourceRefs: [
                  { path: "wiki/entities/robinhood-chain.md", commit: "abc123" },
                ],
                facts: [],
                diagnostics: [],
                questions: [],
              },
            ],
          },
        },
      })),
    readDocument:
      over.readDocument ??
      (async (path: string) => ({ path, commit: "abc123", content: "# Hello" })),
  } as never;
}

describe("buildAskTools", () => {
  test("query tool returns matches and records citations", async () => {
    const tools = buildAskTools(fakeVault());
    const query = tools.find((t) => t.schema.name === "search_vault");
    expect(query).toBeDefined();
    const state: AskState = { citations: [] };
    const out = await query!.execute({ text: "robinhood" }, state);
    expect(out).toContain("wiki/entities/robinhood-chain.md");
    expect(state.citations).toHaveLength(1);
    expect(state.citations[0]?.path).toBe("wiki/entities/robinhood-chain.md");
  });

  test("read_document tool returns content and records a citation", async () => {
    const tools = buildAskTools(fakeVault());
    const read = tools.find((t) => t.schema.name === "read_document");
    const state: AskState = { citations: [] };
    const out = await read!.execute({ path: "wiki/x.md" }, state);
    expect(out).toContain("# Hello");
    expect(state.citations.map((c) => c.path)).toContain("wiki/x.md");
  });

  test("todays_brief returns task text and records citation", async () => {
    const todayVault = fakeVault({
      runView: async (_cmd: string, _args: unknown) => ({
        kind: "ok",
        views: [],
        brokerDiagnostics: [],
        structured: {
          name: "dome.daily.today",
          schema: "dome.daily.today/v1",
          data: {
            openTasks: [
              {
                text: "Reply to vendor",
                path: "inbox/raw/x.md",
                sourceRefs: [{ path: "inbox/raw/x.md", commit: "c1" }],
              },
            ],
            followups: [],
            questions: [],
          },
        },
      }),
    });
    const tools = buildAskTools(todayVault);
    const brief = tools.find((t) => t.schema.name === "todays_brief");
    expect(brief).toBeDefined();
    const state: AskState = { citations: [] };
    const out = await brief!.execute({}, state);
    expect(out).toContain("Reply to vendor");
    expect(state.citations.map((c) => c.path)).toContain("inbox/raw/x.md");
  });

  test("read_document on a missing path returns a not-found message, no citation", async () => {
    const tools = buildAskTools(fakeVault({ readDocument: async () => null }));
    const read = tools.find((t) => t.schema.name === "read_document");
    const state: AskState = { citations: [] };
    const out = await read!.execute({ path: "missing.md" }, state);
    expect(out.toLowerCase()).toContain("not found");
    expect(state.citations).toHaveLength(0);
  });
});
