import { describe, expect, test } from "bun:test";
import { buildAskTools } from "../../src/agent/tools";
import type { AskCitation } from "../../src/agent/types";

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

// The AI SDK passes parsed input to execute(); the second arg is ToolCallOptions.
// Our tools ignore it, so a minimal cast suffices for unit-testing execute.
const callOpts = {} as never;

describe("buildAskTools", () => {
  test("search_vault returns matches and records citations", async () => {
    const citations: AskCitation[] = [];
    const tools = buildAskTools(fakeVault(), citations);
    const out = await tools.search_vault!.execute!({ text: "robinhood" }, callOpts);
    expect(out).toContain("wiki/entities/robinhood-chain.md");
    expect(citations).toHaveLength(1);
    expect(citations[0]?.path).toBe("wiki/entities/robinhood-chain.md");
  });

  test("read_document returns content and records a citation", async () => {
    const citations: AskCitation[] = [];
    const tools = buildAskTools(fakeVault(), citations);
    const out = await tools.read_document!.execute!({ path: "wiki/x.md" }, callOpts);
    expect(out).toContain("# Hello");
    expect(citations.map((c) => c.path)).toContain("wiki/x.md");
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
    const citations: AskCitation[] = [];
    const tools = buildAskTools(todayVault, citations);
    const out = await tools.todays_brief!.execute!({}, callOpts);
    expect(out).toContain("Reply to vendor");
    expect(citations.map((c) => c.path)).toContain("inbox/raw/x.md");
  });

  test("read_document on a missing path returns a not-found message, no citation", async () => {
    const citations: AskCitation[] = [];
    const tools = buildAskTools(fakeVault({ readDocument: async () => null }), citations);
    const out = await tools.read_document!.execute!({ path: "missing.md" }, callOpts);
    expect(String(out).toLowerCase()).toContain("not found");
    expect(citations).toHaveLength(0);
  });
});
