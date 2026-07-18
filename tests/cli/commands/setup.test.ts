import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runSetup } from "../../../src/cli/commands/setup";
import { compileSetupPlan, type SetupCompilerInput } from "../../../src/setup/compiler";

const HEAD = "1".repeat(40);
const HASH = "2".repeat(64);

function evidence(blocked = false): SetupCompilerInput {
  return {
    source: {
      schema: "dome.setup.vault-source-inspection/v1",
      targetPath: "/Users/example/Vault",
      kind: blocked ? "unsafe-or-ambiguous-state" : "new-path",
      git: {
        state: "absent", head: null, branch: null, direct: false, ancestorRoot: null, operationMarkers: [],
      },
      dome: { state: "absent" },
      markdown: { tracked: [], untracked: [] },
      blockers: blocked ? [{
        code: "symlink-ambiguity",
        message: "The selected path is redirected.",
        nextAction: "Choose a direct path, then reassess.",
      }] : [],
      worktreeFingerprint: HASH,
    },
    host: { platform: "darwin", architecture: "arm64" },
    prerequisites: { bun: "1.2.13", git: "2.50.1" },
    product: {
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: HEAD,
      productManifestSha256: HASH,
      packagedHome: { artifactId: HASH, productVersion: "0.4.0", buildCommit: HEAD, manifestSha256: HASH },
    },
    installedHome: {
      state: "absent", artifactId: null, productVersion: null, buildCommit: null,
      manifestSha256: null, selectedVaultPath: null,
    },
    contentScope: { version: 1, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] },
    scaffold: {
      agentsOrientation: "# Vault\n",
      gitignore: ".dome/state/\n",
      vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
    },
  };
}

let output: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  output = [];
  originalLog = console.log;
  console.log = (...parts: unknown[]) => output.push(parts.map(String).join(" "));
});

afterEach(() => { console.log = originalLog; });

describe("runSetup", () => {
  test("requires dry-run before invoking discovery", async () => {
    let calls = 0;
    expect(await runSetup({}, { discover: async () => { calls++; return evidence(); } })).toBe(64);
    expect(calls).toBe(0);
    expect(output).toEqual([]);
  });

  test("prints the exact validated plan as JSON", async () => {
    const input = evidence();
    expect(await runSetup({ dryRun: true, json: true }, { discover: async () => input })).toBe(0);
    expect(JSON.parse(output.join("\n"))).toEqual(compileSetupPlan(input));
  });

  test("reports a blocked preview without presenting applicable work", async () => {
    const input = evidence(true);
    expect(await runSetup({ dryRun: true }, { discover: async () => input })).toBe(1);
    const text = output.join("\n");
    expect(text).toContain("Status: blocked");
    expect(text).toContain("The selected path is redirected.");
    expect(text).toContain("No changes were made.");
    expect(text).not.toContain("Planned actions:");
  });
});
