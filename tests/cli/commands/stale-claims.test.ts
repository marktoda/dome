// `dome stale-claims` — human-renderer unit tests. Full dispatch coverage
// lives in
// tests/harness/scenarios/effect-kinds/stale-claims-via-dome-run.scenario.test.ts.

import { describe, expect, test } from "bun:test";

import {
  renderStaleClaimsText,
  type StaleClaimsData,
} from "../../../src/cli/commands/stale-claims";

describe("renderStaleClaimsText", () => {
  test("no stale claims: single ok-tone line, horizon shown", () => {
    const data: StaleClaimsData = { horizonDays: 120, staleClaims: [] };
    const out = renderStaleClaimsText(data);
    expect(out).toContain("0 stale");
    expect(out).toContain("120");
    expect(out).not.toContain("Stale claims");
  });

  test("stale claims render path, key, value, asOf, and days-stale", () => {
    const data: StaleClaimsData = {
      horizonDays: 120,
      staleClaims: [
        {
          path: "wiki/stale.md",
          key: "Status",
          value: "Shipped",
          asOf: "2020-01-01",
          daysStale: 2000,
        },
      ],
    };
    const out = renderStaleClaimsText(data);
    expect(out).toContain("1 stale");
    expect(out).toContain("wiki/stale.md");
    expect(out).toContain("Status");
    expect(out).toContain("Shipped");
    expect(out).toContain("2020-01-01");
    expect(out).toContain("2000d stale");
  });

  test("multiple stale claims each render their own line", () => {
    const data: StaleClaimsData = {
      horizonDays: 120,
      staleClaims: [
        { path: "wiki/a.md", key: "A", value: "1", asOf: "2020-01-01", daysStale: 500 },
        { path: "wiki/b.md", key: "B", value: "2", asOf: "2020-06-01", daysStale: 300 },
      ],
    };
    const out = renderStaleClaimsText(data);
    expect(out).toContain("2 stale");
    expect(out).toContain("wiki/a.md");
    expect(out).toContain("wiki/b.md");
  });
});
