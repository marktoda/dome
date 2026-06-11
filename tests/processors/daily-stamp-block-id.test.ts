import { describe, expect, test } from "bun:test";

import { stampTaskAnchors } from "../../assets/extensions/dome.daily/processors/action-extraction";
import { parseBlockAnchor } from "../../src/core/block-anchor";

const PATH = "wiki/projects/conv.md";

describe("stampTaskAnchors", () => {
  test("stamps an un-anchored open checkbox task and is idempotent", () => {
    const content = "# Conv\n\n- [ ] ship the follow-up #task\n";
    const stamped = stampTaskAnchors({ path: PATH, content });
    expect(stamped).not.toBeNull();
    const line = stamped!.split("\n").find((l) => l.includes("ship the follow-up"))!;
    const parsed = parseBlockAnchor(line);
    expect(parsed?.id).toMatch(/^t[0-9a-f]{8}$/);
    // Re-running over the stamped output produces no further change.
    expect(stampTaskAnchors({ path: PATH, content: stamped! })).toBeNull();
  });

  test("stamps directive action items", () => {
    const content = "- todo: wire the broker\n";
    const stamped = stampTaskAnchors({ path: PATH, content });
    expect(stamped).not.toBeNull();
    expect(parseBlockAnchor(stamped!.split("\n")[0]!)?.id).toMatch(/^t[0-9a-f]{8}$/);
  });

  test("does not stamp prose or headings", () => {
    const content = "# Heading\n\njust some prose, not a task\n";
    expect(stampTaskAnchors({ path: PATH, content })).toBeNull();
  });

  test("leaves an already-anchored task untouched", () => {
    const content = "- [ ] already done #task ^tdeadbeef\n";
    expect(stampTaskAnchors({ path: PATH, content })).toBeNull();
  });

  test("gives two identical-body tasks in the same file distinct anchors", () => {
    const content = "- [ ] dup task #task\n- [ ] dup task #task\n";
    const stamped = stampTaskAnchors({ path: PATH, content });
    expect(stamped).not.toBeNull();
    const ids = stamped!
      .split("\n")
      .map((l) => parseBlockAnchor(l)?.id)
      .filter((id): id is string => id !== undefined);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  test("is deterministic for the same path and content", () => {
    const content = "- [ ] deterministic #task\n";
    const a = stampTaskAnchors({ path: PATH, content });
    const b = stampTaskAnchors({ path: PATH, content });
    expect(a).toBe(b);
  });

  test("skips Obsidian Tasks query-dashboard files entirely", () => {
    const content = [
      "# Tasks",
      "",
      "```tasks",
      "not done",
      "sort by priority",
      "```",
      "",
      "- [ ] loose task in a dashboard file #task",
      "",
    ].join("\n");
    // A file containing an Obsidian Tasks query block is plugin-managed —
    // Dome must not stamp it (even loose checkboxes outside the query).
    expect(stampTaskAnchors({ path: "notes/tasks.md", content })).toBeNull();
  });

  test("does not stamp checkbox examples inside a fenced code block", () => {
    const content = [
      "# Doc",
      "",
      "```md",
      "- [ ] example task #task",
      "```",
      "",
      "- [ ] real task #task",
      "",
    ].join("\n");
    const stamped = stampTaskAnchors({ path: PATH, content });
    expect(stamped).not.toBeNull();
    const lines = stamped!.split("\n");
    // The fenced example is documentation, not a task — left verbatim.
    expect(lines.find((l) => l.includes("example task"))).toBe(
      "- [ ] example task #task",
    );
    // The real task outside the fence is stamped.
    expect(lines.find((l) => l.includes("real task"))).toMatch(
      /\^t[0-9a-f]{8}$/,
    );
  });

  test("preserves the rest of the document around the stamped line", () => {
    const content = "# Conv\n\nprose line\n\n- [ ] do it #task\n\nmore prose\n";
    const stamped = stampTaskAnchors({ path: PATH, content })!;
    expect(stamped).toContain("# Conv");
    expect(stamped).toContain("prose line");
    expect(stamped).toContain("more prose");
    expect(stamped.split("\n").filter((l) => l.includes("^t")).length).toBe(1);
  });
});
