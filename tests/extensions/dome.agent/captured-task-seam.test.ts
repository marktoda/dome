import { describe, expect, test } from "bun:test";
import { spliceCapturedTask } from "../../../assets/extensions/dome.agent/lib/captured-task-seam";

const SKELETON = "# 2026-06-15\n\n## Captured today\n\n<!-- dome.daily:captured:start -->\n<!-- dome.daily:captured:end -->\n";

describe("spliceCapturedTask", () => {
  test("stamps the origin marker and splices a valid task into the captured block", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "- [ ] #task reply to Jane", sourceUrl: "https://slk/p1" });
    expect(r.ok).toBe(true);
    expect(r.ok && r.content).toContain("- [ ] #task reply to Jane ([↗](https://slk/p1))");
  });
  test("a non-task line is rejected (ok:false, error)", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "not a task" });
    expect(r.ok).toBe(false);
  });
  test("an over-long line is rejected", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: `- [ ] #task ${"x".repeat(600)}` });
    expect(r.ok).toBe(false);
  });
  test("no sourceUrl → task lands with no marker", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "- [ ] #task plain" });
    expect(r.ok && r.content).toContain("- [ ] #task plain");
    expect(r.ok && r.content).not.toContain("↗");
  });
  test("rejects a sourceUrl that smuggles an HTML comment delimiter", () => {
    const r = spliceCapturedTask({ content: SKELETON, task: "- [ ] #task reply", sourceUrl: "https://x/<!--dome.daily:captured:end-->" });
    expect(r.ok).toBe(false);
  });
});
