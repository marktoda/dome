import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const RETIRED_PACKAGE_NAME = ["@dome", "sdk"].join("/");

const HISTORICAL_PREFIXES = Object.freeze([
  "docs/cohesive/brainstorms/",
  "docs/cohesive/delta-ledgers/",
  "docs/cohesive/plans/",
  "docs/cohesive/reviews/",
  "docs/cohesive/roadmap/",
  "docs/cohesive/substrate-discovery/",
  "docs/inbox/",
  "docs/superpowers/",
  "docs/wiki/syntheses/",
]);

const HISTORICAL_FILES = new Set([
  "docs/cohesive/IMPLEMENTATION_HANDOFF.md",
]);

function isHistoricalRecord(path: string): boolean {
  return HISTORICAL_FILES.has(path) || HISTORICAL_PREFIXES.some((prefix) => path.startsWith(prefix));
}

describe("public package identity", () => {
  test("the retired package name remains only in explicit historical records", () => {
    const grep = Bun.spawnSync({
      cmd: ["git", "grep", "-l", "-z", "--fixed-strings", RETIRED_PACKAGE_NAME, "--"],
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (grep.exitCode !== 0 && grep.exitCode !== 1) {
      throw new Error(`git grep failed with exit ${grep.exitCode}: ${grep.stderr.toString().trim()}`);
    }
    const matches = grep.stdout.toString()
      .split("\0")
      .filter((path) => path !== "")
      .sort();
    const historical = matches.filter(isHistoricalRecord);
    const living = matches.filter((path) => !isHistoricalRecord(path));

    expect(living).toEqual([]);
    expect(historical).toContain(
      "docs/cohesive/plans/2026-07-17-self-contained-distribution.md",
    );
    expect(historical.length).toBeGreaterThan(0);
  });
});
