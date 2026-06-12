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

  test("carries the iCloud queue fallback for an unreachable host", async () => {
    expect(await runRecipe({ kind: "ios" })).toBe(0);
    const out = logs.join("\n");

    // Queue-first, phrased the way Shortcuts actually works: no try/catch —
    // a failed "Get Contents of URL" STOPS the shortcut, so the file saved
    // before the POST is the failure branch.
    expect(out).toContain("Save File");
    expect(out).toContain("iCloud Drive");
    expect(out).toContain("DomeCaptures");
    expect(out).toContain("no try/catch");
    expect(out).toContain("STOPS the shortcut");

    // The queue filename is <timestamp>-<uuid>.md, and the SAME string is
    // the POST captureId — either delivery channel dedupes to one capture.
    expect(out).toContain("UUID");
    expect(out).toContain("yyyy-MM-dd-HHmmss");
    expect(out).toContain("[Formatted Date]-[UUID]");
    expect(out).toContain("DomeCaptures/[Text].md");
    expect(out).toContain("captureId → Text");

    // Happy path clears the queue entry; the drain recipe is named.
    expect(out).toContain("Delete Files");
    expect(out).toContain("dome recipe capture-queue");
  });

  test("defaults the base URL to the default port", async () => {
    expect(await runRecipe({ kind: "ios" })).toBe(0);
    expect(logs.join("\n")).toContain(":3663/capture");
  });

  test("unknown kind is a usage error listing the kinds", async () => {
    expect(await runRecipe({ kind: "android" })).toBe(64);
    expect(errors.join("\n")).toContain("unknown recipe");
    expect(errors.join("\n")).toContain(
      "available: ios, capture-queue, core-seed",
    );
  });
});

describe("dome recipe capture-queue", () => {
  test("prints the drain script install, the launchd plist, and the load steps", async () => {
    expect(await runRecipe({ kind: "capture-queue" })).toBe(0);
    const out = logs.join("\n");

    // The shipped script, by its real resolved path, into .dome/bin/.
    expect(out).toContain("assets/source-handlers/drain-captures.sh");
    expect(out).toContain(".dome/bin/drain-captures.sh");
    expect(out).toContain("chmod +x");

    // Both queue-dir candidates (iCloud Drive root + the Shortcuts-folder
    // fallback the Save File action may be restricted to).
    expect(out).toContain("com~apple~CloudDocs/DomeCaptures");
    expect(out).toContain(
      "iCloud~is~workflow~my~workflows/Documents/DomeCaptures",
    );

    // The LaunchAgent: interval unit, vault as the working directory (how
    // `dome capture` resolves the vault), PATH for the dome binary.
    expect(out).toContain("<?xml version=");
    expect(out).toContain("com.dome.drain-captures");
    expect(out).toContain("<key>StartInterval</key><integer>900</integer>");
    expect(out).toContain("<key>WorkingDirectory</key><string><vault></string>");
    expect(out).toContain("RunAtLoad");
    expect(out).toContain("launchctl bootstrap gui/$(id -u)");

    // Smoke test + the idempotency story.
    expect(out).toContain("drain-captures.sh");
    expect(out).toContain("captureId = the filename stem");
    expect(out).toContain("never double-files");

    // The honest-wiring rationale: recipe, not a sources subscription.
    expect(out).toContain("not a dome.sources subscription");
    expect(out).toContain("one output file per period");
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
