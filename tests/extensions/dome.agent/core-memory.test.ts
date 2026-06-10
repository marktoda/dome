// Core-memory injection helper (lib/core-memory.ts): the owner's always-
// loaded core page rides every agent task turn as DATA, never instructions.
// Spec: docs/wiki/specs/autonomous-agents.md §"Core-memory injection".

import { describe, expect, test } from "bun:test";

import {
  CORE_MEMORY_HEADING,
  CORE_MEMORY_MAX_CHARS,
  coreMemoryPath,
  coreMemorySection,
  withCoreMemory,
} from "../../../assets/extensions/dome.agent/lib/core-memory";

const reader = (files: Record<string, string>) => async (p: string) =>
  files[p] ?? null;

describe("coreMemoryPath", () => {
  test("defaults to core.md and accepts a valid relative .md override", () => {
    expect(coreMemoryPath(undefined)).toEqual({ path: "core.md", problem: null });
    expect(coreMemoryPath({})).toEqual({ path: "core.md", problem: null });
    expect(coreMemoryPath({ core_path: "notes/core.md" })).toEqual({
      path: "notes/core.md",
      problem: null,
    });
  });

  test("malformed config degrades to the default with a problem (never throws)", () => {
    const cases: ReadonlyArray<[unknown, string]> = [
      [7, "must be a string"],
      ["", ".md path"],
      ["core.txt", ".md path"],
      [" core.md", ".md path"],
      ["/abs/core.md", "relative vault markdown path"],
      ["../up/core.md", "relative vault markdown path"],
      ["a//b.md", "relative vault markdown path"],
      ["a\\b.md", "relative vault markdown path"],
    ];
    for (const [value, fragment] of cases) {
      const resolved = coreMemoryPath({ core_path: value });
      expect(resolved.path).toBe("core.md");
      expect(resolved.problem).toContain(fragment);
      expect(resolved.problem).toContain("falling back to core.md");
    }
  });
});

describe("coreMemorySection", () => {
  test("absent page → null section, zero noise", async () => {
    const result = await coreMemorySection({ readFile: reader({}) });
    expect(result).toEqual({ path: "core.md", problem: null, section: null });
  });

  test("whitespace-only page → null section", async () => {
    const result = await coreMemorySection({
      readFile: reader({ "core.md": "  \n\n\t\n" }),
    });
    expect(result.section).toBeNull();
  });

  test("present page → data-framed block under the canonical heading", async () => {
    const result = await coreMemorySection({
      readFile: reader({
        "core.md": "# Core memory\n\n## Who I am\nMark, builds Dome.\n",
      }),
    });
    expect(result.section).not.toBeNull();
    const section = result.section ?? "";
    // The heading is the delimiter; the framing names the page as DATA and
    // propose-only; the content rides below it.
    expect(section.startsWith(CORE_MEMORY_HEADING)).toBe(true);
    expect(section).toContain("DATA about the owner");
    expect(section).toContain("not instructions");
    expect(section).toContain("never write core.md");
    expect(section).toContain("askOwner");
    expect(section).toContain("Mark, builds Dome.");
  });

  test("custom core_path is read and named in the framing", async () => {
    const result = await coreMemorySection({
      readFile: reader({ "notes/core.md": "## Who I am\nMark." }),
      config: { core_path: "notes/core.md" },
    });
    expect(result.path).toBe("notes/core.md");
    expect(result.section).toContain("notes/core.md");
    expect(result.section).toContain("Mark.");
  });

  test("malformed core_path mirrors the problem and reads the default path", async () => {
    const result = await coreMemorySection({
      readFile: reader({ "core.md": "## Who I am\nMark." }),
      config: { core_path: 7 },
    });
    expect(result.path).toBe("core.md");
    expect(result.problem).toContain("must be a string");
    expect(result.section).toContain("Mark.");
  });

  test("oversized page is hard-capped with a truncation note", async () => {
    const huge = "x".repeat(CORE_MEMORY_MAX_CHARS + 5_000);
    const result = await coreMemorySection({
      readFile: reader({ "core.md": huge }),
    });
    const section = result.section ?? "";
    expect(section).toContain("…[core memory truncated 5000 chars");
    expect(section).toContain("size budget");
    // Bounded: framing + capped body + note, never the full runaway page.
    expect(section.length).toBeLessThan(CORE_MEMORY_MAX_CHARS + 1_000);
  });

  test("a page exactly at the cap is not truncated (boundary)", async () => {
    const exact = "y".repeat(CORE_MEMORY_MAX_CHARS);
    const result = await coreMemorySection({
      readFile: reader({ "core.md": exact }),
    });
    expect(result.section).not.toContain("truncated");
    expect(result.section).toContain(exact);
  });
});

describe("withCoreMemory", () => {
  test("prepends the section above the task; null section is the identity", () => {
    expect(withCoreMemory(null, "Do the task.")).toBe("Do the task.");
    const composed = withCoreMemory("CORE BLOCK", "Do the task.");
    expect(composed).toBe("CORE BLOCK\n\nDo the task.");
  });
});
