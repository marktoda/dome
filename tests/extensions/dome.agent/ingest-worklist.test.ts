import { describe, expect, test } from "bun:test";
import { selectIngestWorklist, MAX_CAPTURES_PER_RUN } from "../../../assets/extensions/dome.agent/processors/ingest";

describe("selectIngestWorklist", () => {
  test("keeps only inbox/raw/*.md, drops everything else", () => {
    const got = selectIngestWorklist([
      "inbox/raw/a.md",
      "wiki/entities/x.md",
      "inbox/processed/old.md",
      "inbox/raw/sub/nested.md", // nested under raw/ — NOT a capture
      "inbox/raw/b.md",
    ]);
    expect(got).toEqual(["inbox/raw/a.md", "inbox/raw/b.md"]);
  });
  test("sorts oldest-first by filename (timestamp-prefixed = chronological)", () => {
    const got = selectIngestWorklist([
      "inbox/raw/2026-06-16-1500-c.md",
      "inbox/raw/2026-06-16-0900-a.md",
      "inbox/raw/2026-06-16-1200-b.md",
    ]);
    expect(got).toEqual([
      "inbox/raw/2026-06-16-0900-a.md",
      "inbox/raw/2026-06-16-1200-b.md",
      "inbox/raw/2026-06-16-1500-c.md",
    ]);
  });
  test("bounds to the cap, oldest-first", () => {
    const many = Array.from({ length: MAX_CAPTURES_PER_RUN + 5 }, (_, i) =>
      `inbox/raw/2026-06-16-${String(i).padStart(4, "0")}-x.md`,
    );
    const got = selectIngestWorklist(many);
    expect(got).toHaveLength(MAX_CAPTURES_PER_RUN);
    expect(got[0]).toBe("inbox/raw/2026-06-16-0000-x.md");
  });
  test("empty when no captures", () => {
    expect(selectIngestWorklist(["wiki/a.md", "inbox/processed/x.md"])).toEqual([]);
  });
  test("respects an explicit max override", () => {
    const got = selectIngestWorklist(["inbox/raw/a.md", "inbox/raw/b.md", "inbox/raw/c.md"], [], 2);
    expect(got).toEqual(["inbox/raw/a.md", "inbox/raw/b.md"]);
  });

  test("prioritizes just-arrived captures so a backlog can't starve them", () => {
    // A wall of older captures already fills the cap; the freshly-signaled one
    // is the NEWEST (lexically last) so a pure oldest-first bound would exclude
    // it. Prioritizing changedPaths guarantees it is still in the worklist.
    const standing = Array.from({ length: MAX_CAPTURES_PER_RUN + 3 }, (_, i) =>
      `inbox/raw/2026-06-16-${String(i).padStart(4, "0")}-x.md`,
    );
    const fresh = standing[standing.length - 1]!; // the newest
    const got = selectIngestWorklist(standing, [fresh]);
    expect(got).toHaveLength(MAX_CAPTURES_PER_RUN);
    expect(got[0]).toBe(fresh); // fresh first
    expect(got).toContain(fresh);
    // the tail is still oldest-first stragglers (drains the backlog)
    expect(got[1]).toBe("inbox/raw/2026-06-16-0000-x.md");
  });

  test("fresh-first, then oldest; deduped", () => {
    const got = selectIngestWorklist(
      ["inbox/raw/2026-06-16-1500-c.md", "inbox/raw/2026-06-16-0900-a.md", "inbox/raw/2026-06-16-1200-b.md"],
      ["inbox/raw/2026-06-16-1200-b.md"], // b is the just-arrived one
    );
    expect(got).toEqual([
      "inbox/raw/2026-06-16-1200-b.md", // fresh first
      "inbox/raw/2026-06-16-0900-a.md", // then oldest-first stragglers
      "inbox/raw/2026-06-16-1500-c.md",
    ]);
  });

  test("ignores prioritized paths that are absent from the standing set or not captures", () => {
    const got = selectIngestWorklist(
      ["inbox/raw/a.md"],
      ["inbox/raw/deleted.md", "wiki/x.md"], // neither is a standing capture
    );
    expect(got).toEqual(["inbox/raw/a.md"]); // falls back to pure standing order
  });

  test("scheduled tick (no prioritized) is pure oldest-first", () => {
    const got = selectIngestWorklist([
      "inbox/raw/2026-06-16-1200-b.md",
      "inbox/raw/2026-06-16-0900-a.md",
    ]);
    expect(got).toEqual([
      "inbox/raw/2026-06-16-0900-a.md",
      "inbox/raw/2026-06-16-1200-b.md",
    ]);
  });
});
