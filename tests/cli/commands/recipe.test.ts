// tests/cli/commands/recipe.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runRecipe } from "../../../src/cli/commands/recipe";

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origErr = console.error;
beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...p: unknown[]) => {
    logs.push(p.map(String).join(" "));
  };
  console.error = (...p: unknown[]) => {
    errors.push(p.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("dome recipe ios", () => {
  test("prints Shortcut steps targeting the capture endpoint", async () => {
    expect(await runRecipe({ kind: "ios", url: "http://dome-server:3663" }))
      .toBe(0);
    const out = logs.join("\n");
    expect(out).toContain("POST");
    expect(out).toContain("http://dome-server:3663/capture");
    expect(out).toContain("Authorization");
    expect(out).toContain("Dictate Text");
    expect(out).toContain("curl"); // the verification step
    expect(out).toContain("/today?token="); // the cockpit pointer
  });

  test("defaults the base URL to the default port", async () => {
    expect(await runRecipe({ kind: "ios" })).toBe(0);
    expect(logs.join("\n")).toContain(":3663/capture");
  });

  test("unknown kind is a usage error listing both kinds", async () => {
    expect(await runRecipe({ kind: "android" })).toBe(64);
    expect(errors.join("\n")).toContain("unknown recipe");
    expect(errors.join("\n")).toContain("available: ios, core-seed");
  });
});

describe("dome recipe core-seed", () => {
  test("prints the owner interview prompt for seeding core.md", async () => {
    expect(await runRecipe({ kind: "core-seed" })).toBe(0);
    const out = logs.join("\n");

    // The three core.md sections, by name.
    expect(out).toContain("## Who I am");
    expect(out).toContain("## Active projects");
    expect(out).toContain("## Standing preferences");

    // The pasteable interview prompt covers role/team/preferences/focus...
    expect(out).toContain("role");
    expect(out).toContain("team");
    expect(out).toContain("standing preferences");
    expect(out).toContain("focused on");

    // ...drafts only the two owner-authored sections, for owner edit...
    expect(out).toContain("for my edit and approval");

    // ...and carries the guardrails: size budget, marker-delimited blocks
    // are off-limits, Active projects is generated.
    expect(out).toContain("6,000-character budget");
    expect(out).toContain("NEVER write inside marker-delimited");
    expect(out).toContain("generated");
    expect(out).toContain("do not hand-author");
  });
});
