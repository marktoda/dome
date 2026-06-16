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
    const got = selectIngestWorklist(["inbox/raw/a.md", "inbox/raw/b.md", "inbox/raw/c.md"], 2);
    expect(got).toEqual(["inbox/raw/a.md", "inbox/raw/b.md"]);
  });
});
