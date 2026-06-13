// tests/extensions/index-render.test.ts — pure renderer, no vault needed.
import { describe, expect, test } from "bun:test";

import {
  renderIndexFiles,
  type IndexEntry,
} from "../../assets/extensions/dome.markdown/lib/index-render";

const entries: IndexEntry[] = [
  { path: "wiki/entities/alice.md", description: "Engineer", category: "entities" },
  { path: "wiki/entities/bob.md", description: "Designer", category: "entities" },
  { path: "wiki/concepts/flow.md", description: "A process idea", category: "concepts" },
];

describe("renderIndexFiles", () => {
  test("renders a root map plus one shard per non-empty category", () => {
    const files = renderIndexFiles(entries, { shardBudgetChars: 24_000 });
    expect(Object.keys(files).sort()).toEqual([
      "index.md",
      "meta/index-concepts.md",
      "meta/index-entities.md",
    ]);
    expect(files["meta/index-entities.md"]).toContain(
      "- [[wiki/entities/alice]] — Engineer",
    );
    expect(files["index.md"]).toContain("[[meta/index-entities]]");
    expect(files["index.md"]).toContain("2"); // entity count in the root map
    // Every file's body lives inside the generated block markers.
    expect(files["index.md"]).toContain("<!-- dome.markdown:index-catalog:start -->");
    expect(files["index.md"]).toContain("<!-- dome.markdown:index-catalog:end -->");
    expect(files["meta/index-entities.md"]).toContain(
      "<!-- dome.markdown:index-catalog:start -->",
    );
    expect(files["meta/index-entities.md"]).toContain(
      "<!-- dome.markdown:index-catalog:end -->",
    );
  });

  test("entries sorted by path; deterministic output", () => {
    const a = renderIndexFiles(entries, { shardBudgetChars: 24_000 });
    const b = renderIndexFiles([...entries].reverse(), { shardBudgetChars: 24_000 });
    expect(a).toEqual(b);
  });

  test("paginates a shard past the size budget", () => {
    const many: IndexEntry[] = Array.from({ length: 50 }, (_, i) => ({
      path: `wiki/entities/person-${String(i).padStart(2, "0")}.md`,
      description: "x".repeat(200),
      category: "entities",
    }));
    const files = renderIndexFiles(many, { shardBudgetChars: 4_000 });
    expect(files["meta/index-entities.md"]).toBeDefined();
    expect(files["meta/index-entities-2.md"]).toBeDefined();
    expect(files["index.md"]).toContain("[[meta/index-entities-2]]");
  });

  test("empty input renders nothing (no empty registry files)", () => {
    expect(renderIndexFiles([], { shardBudgetChars: 24_000 })).toEqual({});
  });

  test("missing description renders the link with a muted placeholder", () => {
    const files = renderIndexFiles(
      [{ path: "wiki/entities/c.md", description: null, category: "entities" }],
      { shardBudgetChars: 24_000 },
    );
    expect(files["meta/index-entities.md"]).toContain(
      "- [[wiki/entities/c]] — *(no description yet)*",
    );
  });
});
