---
type: linter
created: 2026-05-27
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-27-dome-v1-engine-model]]"
description: Flags mutation calls (Bun.write, writeFile, SQL INSERT/UPDATE, git.commit) outside the engine — catches call sites the import linter misses.
status: v1 (proposed; lockstep check ships in Phase 1 of implementation)
---

# no-direct-mutation-outside-engine

**Status:** v1 substrate; companion to [[wiki/linters/engine-is-sole-applier]]. The lockstep check ships as part of Phase 1 of v1 implementation per the brainstorm's "Phasing the cut" section.

**Statement:** Source files under `src/` outside `src/engine/`, `src/projections/`, `src/ledger/`, and `src/outbox/` do not make direct mutation calls. The forbidden call patterns include `Bun.write`, `fs.writeFile`, `db.exec`/`db.run`/`db.prepare(...).run`, `git.commit`, and equivalents.

## Why a companion to engine-is-sole-applier?

[[wiki/linters/engine-is-sole-applier]] catches **imports** of mutation modules. This linter catches **calls** to mutation functions — distinct because:

1. A file may legitimately import `node:fs` for read-only purposes (the watcher does this) but must not call `fs.writeFile`.
2. A file may receive a mutation handle as a parameter (e.g., a `db: Database` argument) without importing the module — the import is in the caller; the call site is the violation.
3. Dynamic imports (`await import("node:fs")`) bypass static-import analysis; the static call-site check catches them.

Together: engine-is-sole-applier protects the *contract* (modules that can mutate live only in the engine); no-direct-mutation-outside-engine protects the *implementation* (no caller outside the engine reaches mutation functions even if the module is imported elsewhere or accessed dynamically).

## What it checks

The check is a regex sweep over `src/**/*.ts` outside `src/engine/`, `src/projections/`, `src/ledger/`, `src/outbox/`, and the whitelist:

**Forbidden call patterns** (regex-shaped; the implementation uses AST inspection in v1.1+ for higher precision):

- `Bun.write(` — filesystem write.
- `Bun.file(...).write` — pipe-style filesystem write.
- `\.writeFile(` — `fs.writeFile`, `fs.writeFileSync`, `fsPromises.writeFile`, etc.
- `\.appendFile(` — `fs.appendFile` and analogues.
- `\.unlink(` / `\.unlinkSync(` — file deletion.
- `\.rename(` / `\.renameSync(` — file rename.
- `\.mkdir(` / `\.mkdirSync(` / `\.rmdir(` — directory mutation.
- `\.execute\(["'`]\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)` — SQL mutations against SQLite.
- `\.run\(["'`]\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)` — Bun.sqlite `.run()` form.
- `git\.commit(` / `commit\(\s*{` (in isomorphic-git context) — git commit.
- `git\.add(` / `git\.checkout(` / `git\.merge(` / `git\.push(` / `git\.writeRef(` — git mutations.

**Allowed escape hatches:**

- Test files (`tests/**`).
- The whitelisted `src/watcher.ts` (which calls `fs.stat` and `fs.watch`, both read-only).
- Host-level CLI scaffolding at the compiler boundary, whitelisted as
  `ALLOWED_FILES` in the shipped check: `src/cli/commands/init.ts` (vault
  construction), `src/cli/commands/install.ts` (launchd LaunchAgent plist
  under `~/Library/LaunchAgents/` + the gitignored `.dome/state/` log dir),
  and `src/surface/capture.ts` (the human-side write path: `dome
  capture` writes one raw capture file and lands it as an ordinary
  trailer-less commit, exactly like a text editor + `git commit`; not an
  engine write path — the daemon constructs the Proposal from the resulting
  branch drift). These write host/vault scaffolding or human-side captures,
  never engine-applied vault content — engine writes still flow through
  Proposals.
- Files annotated with `// @engine-internal: <justification>` at the top.

## Why this exists

The engine boundary is the v1 substrate's most load-bearing trust property. If any module outside `src/engine/` can directly mutate state, the broker, ledger, projection, and outbox are bypassable. Reviewer attention is not a reliable fence at long tail (a new contributor adding a "quick fix" reaches for `Bun.write` without realizing it bypasses the engine).

The linter is the structural fence. CI catches the call site before merge.

## Implementation sketch (v1 Phase 1)

The regex-based v1 implementation is intentionally simple — easy to extend, easy to debug. The v1.1+ implementation upgrades to TypeScript AST inspection via `ts-morph` or `@typescript-eslint/parser` for higher precision (catches method calls regardless of identifier renaming, catches calls through variable aliases).

```ts
// tests/integration/no-direct-mutation-outside-boundaries.test.ts
import { test, expect } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";

const ENGINE_DIRS = ["src/engine/", "src/projections/", "src/ledger/", "src/outbox/"];
const WHITELIST = ["src/watcher.ts"];
const FORBIDDEN_PATTERNS = [
  /Bun\.write\(/,
  /\.writeFile(?:Sync)?\(/,
  /\.appendFile(?:Sync)?\(/,
  /\.unlink(?:Sync)?\(/,
  /\.rename(?:Sync)?\(/,
  /\.mkdir(?:Sync)?\(/,
  /\.execute\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i,
  /\.run\(\s*['"`]\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)/i,
  /git\.(?:commit|add|checkout|merge|push|writeRef|writeBlob|writeTree)\(/,
];

test("no-direct-mutation-outside-engine", async () => {
  const violations: string[] = [];
  for await (const file of new Glob("src/**/*.ts").scan(".")) {
    if (ENGINE_DIRS.some(d => file.startsWith(d))) continue;
    if (WHITELIST.includes(file)) continue;
    const text = await readFile(file, "utf8");
    if (text.startsWith("// @engine-internal:")) continue;
    for (const pattern of FORBIDDEN_PATTERNS) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (pattern.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
  }
  expect(violations).toEqual([]);
});
```

## Related

- [[wiki/linters/engine-is-sole-applier]] (companion; catches imports rather than calls)
- [[wiki/linters/processor-purity]] (extends the same property to extension-bundle processors)
- [[wiki/invariants/ENGINE_IS_THE_ONLY_APPLIER]]
