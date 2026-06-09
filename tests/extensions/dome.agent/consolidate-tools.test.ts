import { describe, expect, test } from "bun:test";
import { makeConsolidatorTools } from "../../../assets/extensions/dome.agent/lib/consolidate-tools";

const reader = () => ({
  readFile: async () => null,
  listMarkdownFiles: async () => [],
});

describe("makeConsolidatorTools", () => {
  test("provides the consolidator tool set incl. deletePage, excl. inbox tools", async () => {
    const names = makeConsolidatorTools({ reader: reader() })
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
