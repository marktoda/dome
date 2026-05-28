import { describe, expect, test } from "bun:test";

import type { Capability } from "../../src/core/processor";
import {
  filterReadablePaths,
  pathCapabilityEffectiveFor,
  readablePath,
} from "../../src/engine/path-capabilities";

const declared: ReadonlyArray<Capability> = Object.freeze([
  { kind: "read", paths: ["wiki/**"] },
  { kind: "patch.auto", paths: ["wiki/generated/**"] },
]);

const granted: ReadonlyArray<Capability> = Object.freeze([
  { kind: "read", paths: ["wiki/public/**"] },
  { kind: "patch.auto", paths: ["wiki/generated/**"] },
]);

describe("path-capabilities", () => {
  test("enforces declared and granted intersection", () => {
    expect(
      pathCapabilityEffectiveFor(
        "read",
        "wiki/public/a.md",
        declared,
        granted,
      ),
    ).toBe(true);
    expect(
      pathCapabilityEffectiveFor("read", "wiki/private/a.md", declared, granted),
    ).toBe(false);
  });

  test("canonicalizes readable paths and rejects invalid paths", () => {
    const path = readablePath("wiki//public/a.md", declared, granted);
    expect(path as string | null).toBe("wiki/public/a.md");
    expect(readablePath("../secret.md", declared, granted)).toBeNull();
  });

  test("filters readable path lists", () => {
    expect(
      filterReadablePaths(
        ["wiki/public/a.md", "wiki/private/a.md", "secret/denied.md"],
        declared,
        granted,
      ).map((path) => path as string),
    ).toEqual(["wiki/public/a.md"]);
  });
});
