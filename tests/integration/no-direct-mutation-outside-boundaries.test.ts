import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const ALLOWED_DIRS = [
  "src/engine/",
  "src/answers/",
  "src/projections/",
  "src/ledger/",
  "src/outbox/",
];

const ALLOWED_FILES = new Set([
  "src/engine-commit.ts",
  "src/git.ts",
  "src/cli/commands/init.ts",
  // Host-level service scaffolding (launchd plist / systemd user unit +
  // gitignored log dir), not an engine write path — same boundary class as
  // init.ts.
  "src/cli/commands/install.ts",
  "src/cli/commands/install-systemd.ts",
  // The human-side write path: `dome capture` writes one raw capture file
  // and lands it as an ordinary (trailer-less) commit, exactly like a text
  // editor + `git commit`. Not an engine write path — the daemon constructs
  // the Proposal from the resulting branch drift.
  "src/surface/capture.ts",
  // The explicit adopted-ref divergence recovery chokepoint: moves
  // refs/dome/adopted/<branch> (with a refs/dome/backup/ copy first) via the
  // src/git ref helpers after the user confirms a history rewrite. The only
  // user-facing non-fast-forward cursor move; see
  // docs/wiki/gotchas/adopted-ref-divergence.md.
  "src/cli/commands/reanchor.ts",
  // The ask-server's POST /transcribe handler writes the uploaded audio to a
  // mkdtemp temp directory, invokes the configured whisper command against it,
  // and deletes the dir in a finally block. This is a process-scoped temp-file
  // write (not a vault write), in the same boundary class as capture.ts.
  "src/agent/server.ts",
]);

const FORBIDDEN_PATTERNS: ReadonlyArray<{
  readonly name: string;
  readonly pattern: RegExp;
}> = [
  { name: "Bun.write", pattern: /\bBun\.write\(/ },
  { name: "writeFile", pattern: /\.writeFile(?:Sync)?\(|\bwriteFile\(/ },
  { name: "appendFile", pattern: /\.appendFile(?:Sync)?\(|\bappendFile\(/ },
  { name: "unlink", pattern: /\.unlink(?:Sync)?\(|\bunlink\(/ },
  { name: "rename", pattern: /\.rename(?:Sync)?\(|\brename\(/ },
  { name: "mkdir", pattern: /\.mkdir(?:Sync)?\(|\bmkdir\(/ },
  {
    name: "sqlite mutation",
    pattern: /\.(?:exec|run)\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i,
  },
  {
    name: "git mutation",
    pattern: /\bgit\.(?:commit|add|checkout|merge|push|writeRef|writeBlob|writeTree)\(/,
  },
];

describe("no direct mutation outside engine boundaries", () => {
  test("source files outside approved mutation boundaries do not call write APIs", async () => {
    const violations: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (isAllowedMutationBoundary(file)) continue;
      const text = await readFile(file, "utf8");
      if (text.startsWith("// @engine-internal:")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? "";
        for (const forbidden of FORBIDDEN_PATTERNS) {
          if (forbidden.pattern.test(line)) {
            violations.push(
              `${file}:${i + 1}: ${forbidden.name}: ${line.trim()}`,
            );
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function isAllowedMutationBoundary(file: string): boolean {
  return (
    ALLOWED_DIRS.some((dir) => file.startsWith(dir)) ||
    ALLOWED_FILES.has(file)
  );
}
