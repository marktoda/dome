// `dome orphan-pages` — human-renderer unit tests. Full dispatch coverage
// lives in
// tests/harness/scenarios/effect-kinds/view-effect-via-dome-run.scenario.test.ts.

import { describe, expect, test } from "bun:test";

import {
  renderOrphanPagesText,
  type OrphanPagesData,
} from "../../../src/cli/commands/orphan-pages";

describe("renderOrphanPagesText", () => {
  test("no orphans: single ok-tone line with scan count", () => {
    const data: OrphanPagesData = {
      totalScanned: 12,
      totalOrphans: 0,
      orphans: [],
    };
    const out = renderOrphanPagesText(data);
    expect(out).toContain("0 orphans");
    expect(out).toContain("12 pages scanned");
    expect(out).not.toContain("Orphans");
  });

  test("orphans render each path", () => {
    const data: OrphanPagesData = {
      totalScanned: 3,
      totalOrphans: 2,
      orphans: [
        { path: "wiki/lonely.md", incomingLinkCount: 0, reason: "no incoming links and not in root index" },
        { path: "wiki/bar.md", incomingLinkCount: 0, reason: "no incoming links and not in root index" },
      ],
    };
    const out = renderOrphanPagesText(data);
    expect(out).toContain("2 orphans of 3 pages");
    expect(out).toContain("wiki/lonely.md");
    expect(out).toContain("wiki/bar.md");
  });
});
