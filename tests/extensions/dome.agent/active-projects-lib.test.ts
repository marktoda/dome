// Pure renderer for core.md's dome.agent:active-projects generated block
// (v1 chunk 3b Task 3). Deterministic: sorted (openLoops desc, lastTouched
// desc, page asc), capped, singular/plural line grammar, fixed empty state.

import { describe, expect, test } from "bun:test";

import {
  ACTIVE_PROJECTS_BLOCK,
  ACTIVE_PROJECTS_EMPTY_STATE,
  renderActiveProjects,
  type ActiveProjectItem,
} from "../../../assets/extensions/dome.agent/lib/active-projects";

const item = (
  page: string,
  openLoops: number,
  lastTouched: string,
): ActiveProjectItem => Object.freeze({ page, openLoops, lastTouched });

describe("renderActiveProjects", () => {
  test("sorts by openLoops desc, then lastTouched desc, then page asc", () => {
    const rendered = renderActiveProjects(
      [
        item("wiki/entities/zeta.md", 1, "2026-06-09"),
        item("wiki/entities/acme.md", 3, "2026-06-08"),
        item("wiki/concepts/pricing.md", 1, "2026-06-10"),
        item("wiki/entities/beta.md", 1, "2026-06-09"),
      ],
      { limit: 5 },
    );
    expect(rendered.split("\n")).toEqual([
      "- [[wiki/entities/acme]] — 3 open loops, last touched 2026-06-08",
      "- [[wiki/concepts/pricing]] — 1 open loop, last touched 2026-06-10",
      "- [[wiki/entities/beta]] — 1 open loop, last touched 2026-06-09",
      "- [[wiki/entities/zeta]] — 1 open loop, last touched 2026-06-09",
    ]);
  });

  test("caps the list at the limit (after sorting)", () => {
    const rendered = renderActiveProjects(
      [
        item("wiki/a.md", 1, "2026-06-01"),
        item("wiki/b.md", 2, "2026-06-01"),
        item("wiki/c.md", 3, "2026-06-01"),
      ],
      { limit: 2 },
    );
    expect(rendered.split("\n")).toEqual([
      "- [[wiki/c]] — 3 open loops, last touched 2026-06-01",
      "- [[wiki/b]] — 2 open loops, last touched 2026-06-01",
    ]);
  });

  test("singular '1 open loop', plural 'n open loops'", () => {
    const rendered = renderActiveProjects(
      [
        item("wiki/one.md", 1, "2026-06-01"),
        item("wiki/two.md", 2, "2026-06-02"),
      ],
      { limit: 5 },
    );
    expect(rendered).toContain("— 1 open loop, last touched");
    expect(rendered).toContain("— 2 open loops, last touched");
    expect(rendered).not.toContain("1 open loops");
  });

  test("empty input renders the fixed empty-state line", () => {
    expect(renderActiveProjects([], { limit: 5 })).toBe(
      "_(no active projects detected — open loops feed this block)_",
    );
    expect(ACTIVE_PROJECTS_EMPTY_STATE).toBe(
      "_(no active projects detected — open loops feed this block)_",
    );
  });

  test("deterministic: reversed input renders byte-identical output", () => {
    const items = [
      item("wiki/entities/acme.md", 3, "2026-06-08"),
      item("wiki/concepts/pricing.md", 1, "2026-06-10"),
      item("wiki/entities/beta.md", 1, "2026-06-09"),
      item("wiki/entities/zeta.md", 1, "2026-06-09"),
    ];
    const forward = renderActiveProjects(items, { limit: 3 });
    const reversed = renderActiveProjects([...items].reverse(), { limit: 3 });
    expect(reversed).toBe(forward);
  });

  test("input array is not mutated by sorting", () => {
    const items = [
      item("wiki/b.md", 1, "2026-06-01"),
      item("wiki/a.md", 2, "2026-06-02"),
    ];
    const before = JSON.stringify(items);
    renderActiveProjects(items, { limit: 5 });
    expect(JSON.stringify(items)).toBe(before);
  });

  test("block identity is the dome.agent:active-projects pair", () => {
    expect(ACTIVE_PROJECTS_BLOCK).toEqual({
      owner: "dome.agent",
      block: "active-projects",
    });
  });
});
