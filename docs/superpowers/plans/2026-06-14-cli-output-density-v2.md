# CLI Output Density v2 — Signal-First, Calm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the default human CLI output verdict-first and signal-only — show only what needs attention plus the next action, collapse healthy/zero/empty states to one line, and move the full breakdown behind `--verbose` — while keeping `--json` byte-identical (one additive `summary` field aside).

**Architecture:** Extend the v1 presenter layer (`src/cli/presenter/`) with two pure primitives (`signalLine`, `rollup`) and a verbose-aware `finding`; thread a resolved `verbose` boolean (from a new `--verbose`/`-v` flag) into the renderers of `status`/`check`/`doctor`/`lint`; restyle each command to glyph-led, inset, lowercase, footer-less output; and author a terse `summary` on the highest-value first-party `dome.*` diagnostics (additive to their type and `--json`, with the renderer falling back to the full `message` when absent).

**Tech Stack:** TypeScript on Bun; `bun:test`; `picocolors`; `string-width`. Presenter primitives are pure `(input, Caps[, verbose])`. Tests inject `Caps` and assert exact strings.

**Spec:** `docs/superpowers/specs/2026-06-14-cli-output-density-v2-design.md`
**Predecessors:** `docs/superpowers/specs/2026-06-12-cli-output-readability-design.md` (v1), `docs/superpowers/specs/2026-06-03-cli-presenter-design.md`.

**Run tests:** `bun test <path>` (one file) / `bun test tests/cli` / `bun run typecheck` (CI runs `tsc` — MUST stay green; the repo has `exactOptionalPropertyTypes: true`, so never assign `string | undefined` into an optional `?: string` field — omit the key via conditional spread).

---

## File structure

**Modify (presenter):**
- `src/cli/presenter/primitives.ts` — add `signalLine()`, `rollup()`; extend `Finding` (+`why?`) and `finding()` (verbose-aware).
- `src/cli/presenter/index.ts` — exports flow through `export *` already; no change unless new files added.

**Modify (commands):**
- `src/cli/commands/status.ts`, `check.ts`, `doctor.ts`, `lint.ts` — default signal-only view + `--verbose` full view; delete `footer`/`rule` usage; inset/lowercase/glyph-led.
- `src/cli/commands/health-finding-view.ts` — map `summary`→`what`, `message`→verbose `why`.
- `src/cli/commands/query.ts`, `log.ts`, `inspect.ts` — inset + verdict conform; inspect empty-state collapse + lowercase headers.
- `src/cli/index.ts` — add `--verbose`/`-v` option to status/check/doctor/lint command definitions.

**Modify (diagnostics — the one cross-layer reach):**
- `src/engine/host/health.ts` — add optional `summary` to `HealthFinding` variants; author it for `capability.grant-*` (+ a few high-value codes).
- `assets/extensions/dome.markdown/manifest.yaml` — author terse `summary` strings where the lint diagnostics' messages live (verify exact location first).

**Test files:** `tests/cli/presenter/primitives.test.ts`, `tests/cli/commands/{status,check,doctor,lint,inspect}.test.ts`, plus any `tests/harness/scenarios/cli-surface/*` that assert old shapes.

---

## Task 1: Thread a `verbose` flag through status/check/doctor/lint (plumbing only)

**Files:**
- Modify: `src/cli/index.ts` (command definitions), `src/cli/commands/{status,check,doctor,lint}.ts` (options types + render entry)
- Test: `tests/cli/index.test.ts` or the per-command tests

- [ ] **Step 1: Read** `src/cli/index.ts` and find the `.command("status")`, `check`, `doctor`, `lint` definitions and their `RunXOptions` types. Note how existing options like `--json` are declared (`.option("--json", "...")`) and passed into `runStatus(options)` etc.

- [ ] **Step 2: Write the failing test** — in `tests/cli/commands/status.test.ts`, assert the options type/flow accepts `verbose`. Simplest: a test that calls the render with `{ verbose: true }` and expects MORE lines than `{ verbose: false }` once Task 8 lands — but for THIS task, just assert the flag is accepted without error. Add to the command test:

```ts
test("runStatus accepts a verbose option without error", async () => {
  // build the same snapshot fixture the other tests use, with json:false
  const code = await runStatus({ vault: FIXTURE_VAULT, verbose: true } as RunStatusOptions, DEPS);
  expect(code).toBe(0);
});
```
(Adapt `FIXTURE_VAULT`/`DEPS` to the file's existing harness.)

- [ ] **Step 3: Run** `bun test tests/cli/commands/status.test.ts` → FAIL (type error: `verbose` not on `RunStatusOptions`).

- [ ] **Step 4: Implement** — add `readonly verbose?: boolean | undefined;` to `RunStatusOptions`/`RunCheckOptions`/`RunDoctorOptions`/`RunLintOptions`. In `src/cli/index.ts`, add `.option("-v, --verbose", "Show the full breakdown.")` to each of the 4 commands, and pass `verbose: options.verbose` into the `runX` call (Commander puts it on `options.verbose`). In each `runX`, plumb `verbose = options.verbose === true` down to the text-render function signature (add a `verbose` param to `printStatusText`/etc., default `false`; do not use it yet).

- [ ] **Step 5: Run** `bun test tests/cli/commands/status.test.ts tests/cli/commands/check.test.ts tests/cli/commands/doctor.test.ts tests/cli/commands/lint.test.ts` → PASS. Run `bun run typecheck` → clean.

- [ ] **Step 6: Commit**
```bash
git add src/cli/index.ts src/cli/commands/status.ts src/cli/commands/check.ts src/cli/commands/doctor.ts src/cli/commands/lint.ts tests/cli/commands/status.test.ts
git commit -m "feat(cli): add --verbose/-v flag plumbed to status/check/doctor/lint renderers"
```

---

## Task 2: `signalLine` primitive

**Files:** Modify `src/cli/presenter/primitives.ts`; Test `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { signalLine } from "../../../src/cli/presenter/primitives";

describe("signalLine", () => {
  const UNI = { color: false, unicode: true, width: 80 };
  test("glyph leads, label in an aligned column, detail follows", () => {
    expect(signalLine("warn", "sync", "45 pending, synced 11h ago", 12, UNI))
      .toBe("  ⚠ sync         45 pending, synced 11h ago");
  });
  test("ok tone uses the check glyph", () => {
    expect(signalLine("ok", "draft", "clean", 12, UNI))
      .toBe("  ✓ draft        clean");
  });
  test("empty detail omits trailing spaces", () => {
    expect(signalLine("muted", "serve", "", 12, UNI)).toBe("  ○ serve");
  });
});
```
(Lock the exact column spacing to actual after first run if the hand-count is off — the contract is: 2-space inset, glyph, space, label left-padded to `labelWidth`, 3-space gap, detail; no trailing whitespace when detail empty.)

- [ ] **Step 2: Run** → FAIL (`signalLine` undefined).

- [ ] **Step 3: Implement** (add near `kv`; reuse `statusGlyph`, `paint`, `pad`, `glyph`):

```ts
/**
 * One glyph-led status line: `  <glyph> <label>   <detail>`. The glyph is the
 * tone's status glyph (✓/⚠/✗/•/○), painted in the tone; the label is padded to
 * `labelWidth` and dim; the detail is plain. No trailing whitespace when detail
 * is empty.
 */
export function signalLine(
  tone: Tone,
  label: string,
  detail: string,
  labelWidth: number,
  caps: Caps,
): string {
  const g = paint(statusGlyph(tone, caps), tone, caps);
  const lbl = paint(pad(label, labelWidth), "muted", caps);
  if (detail.length === 0) return `  ${g} ${paint(label, "muted", caps)}`;
  return `  ${g} ${lbl}   ${detail}`;
}
```

- [ ] **Step 4: Run** → PASS (lock spacing if needed).

- [ ] **Step 5: Commit**
```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): signalLine primitive — glyph-led status line"
```

---

## Task 3: `rollup` primitive

**Files:** Modify `src/cli/presenter/primitives.ts`; Test `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { rollup } from "../../../src/cli/presenter/primitives";

describe("rollup", () => {
  const UNI = { color: false, unicode: true, width: 80 };
  test("lists the clean categories after a check glyph", () => {
    expect(rollup(["outbox", "runs", "quarantine"], UNI))
      .toBe("  ✓ outbox, runs, quarantine all clean");
  });
  test("empty list yields the generic everything-else line", () => {
    expect(rollup([], UNI)).toBe("  ✓ everything else clean");
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement**

```ts
/**
 * Collapse the set of healthy checks into one line. With names, lists them:
 * `✓ a, b, c all clean`. With none given, the generic `✓ everything else clean`.
 */
export function rollup(cleanLabels: ReadonlyArray<string>, caps: Caps): string {
  const g = paint(statusGlyph("ok", caps), "ok", caps);
  if (cleanLabels.length === 0) return `  ${g} everything else clean`;
  return `  ${g} ${cleanLabels.join(", ")} all clean`;
}
```

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit**
```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): rollup primitive — collapse healthy checks to one line"
```

---

## Task 4: verbose-aware `finding` (terse `what` + optional `why`)

**Files:** Modify `src/cli/presenter/primitives.ts`; Test `tests/cli/presenter/primitives.test.ts`

- [ ] **Step 1: Read** the current `Finding` type + `finding()` in `primitives.ts` (it has `severity, code, subject?, what, note?, fix?` and renders header / what / note / fix). The v1 `note` line was rendered when present. v2 reframes: `what` is the terse essence (always shown); a new `why?` is the consequence, shown ONLY when `verbose`. Keep `note?` working for backward-compat OR fold it into `why` (prefer: rename the verbose-only consequence path to `why`; leave `note` rendering as-is if any caller still passes it — check callers with `grep -n "note:" src/cli`).

- [ ] **Step 2: Write the failing test**

```ts
test("finding hides why by default, shows it under verbose", () => {
  const f: Finding = {
    severity: "warning", code: "x.y", subject: "p",
    what: "core.md declared read but missing from the grant",
    why: "the core-size lint never fires — read scope is empty",
    fix: "add core.md to the grant",
  };
  const UNI = { color: false, unicode: true, width: 80 };
  expect(finding(f, UNI)).toEqual([
    "  ⚠ x.y · p",
    "      core.md declared read but missing from the grant",
    "      fix    add core.md to the grant",
  ]);
  expect(finding(f, UNI, true)).toEqual([
    "  ⚠ x.y · p",
    "      core.md declared read but missing from the grant",
    "      why    the core-size lint never fires — read scope is empty",
    "      fix    add core.md to the grant",
  ]);
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — add `readonly why?: string;` to `Finding`; change the signature to `finding(f: Finding, caps: Caps, verbose = false)`. Render order: header → `what` (wrapped) → `why` (only when `verbose` AND present, via the existing `findingLabeledLines("why", f.why, caps)`) → `fix`. Keep `note` rendering if a caller still uses it, but the v2 path uses `why`.

- [ ] **Step 5: Run** → PASS. Run `grep -rn "finding(" src/cli` and confirm existing callers still compile (they pass no third arg → `verbose=false`, same as today minus the `note` line if you removed it — if any caller passed `note`, migrate it to `why`).

- [ ] **Step 6: Commit**
```bash
git add src/cli/presenter/primitives.ts tests/cli/presenter/primitives.test.ts
git commit -m "feat(cli): finding shows why only under verbose; what stays terse"
```

---

## Task 5: `summary` on HealthFinding + capability findings, wired through the bridge

**Files:** Modify `src/engine/host/health.ts`, `src/cli/commands/health-finding-view.ts`; Test `tests/cli/commands/check.test.ts`, plus any health unit test.

- [ ] **Step 1: Read** `src/engine/host/health.ts` — the `HealthFinding` union (each variant has `message`/`recovery`) and the probe(s) that build the `capability.grant-*` findings (~line 745). Note the variant shapes.

- [ ] **Step 2: Write the failing test** — in `tests/cli/commands/check.test.ts`, assert that a capability finding renders a TERSE summary by default and the full message only under verbose:

```ts
test("capability finding shows terse summary by default, full message under verbose", () => {
  // reuse the fixture that produces capability.grant-entry-missing for dome.markdown.core-size
  expect(defaultRender).toContain("core.md declared 'read' but missing from the grant");
  expect(defaultRender).not.toContain("the core-memory size lint never fires");
  expect(verboseRender).toContain("the core-memory size lint never fires");
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement**
  - In `health.ts`: add `readonly summary?: string;` to the `capability.grant-missing|grant-entry-missing|grant-starved` variants (and, while there, the other variants are fine to leave without `summary`). At the emission site, author a terse `summary` for each, e.g. for `grant-entry-missing`: `` `${declaredEntries} declared but not covered by the vault grant` `` (one line, no consequence clause). Keep the existing `message` and `recovery` exactly as-is.
  - In `health-finding-view.ts`: change `findingLines` to accept `verbose: boolean`, map `what: hf.summary ?? hf.message` and `...(verbose && hf.summary ? { why: hf.message } : {})` (so when a summary exists, the full message becomes the verbose `why`; when no summary, `what` is the full message and there's no `why`). Pass `verbose` into `finding(f, caps, verbose)`.
  - Update the two callers (`check.ts`, `doctor.ts`) to pass their `verbose` into `findingLines(findings, caps, verbose)` (wired in Tasks 9–10; for now default `false` is fine if those tasks haven't landed — but since this task changes the signature, update both call sites now to pass `verbose ?? false`).

- [ ] **Step 5: Run** `bun test tests/cli/commands/check.test.ts tests/cli/commands/doctor.test.ts` → PASS. `bun run typecheck` → clean. Confirm `--json` still carries the full `message` (and now also `summary`): a quick assertion that the JSON finding has both fields.

- [ ] **Step 6: Commit**
```bash
git add src/engine/host/health.ts src/cli/commands/health-finding-view.ts src/cli/commands/check.ts src/cli/commands/doctor.ts tests/cli/commands/check.test.ts
git commit -m "feat(health): author terse summary on capability findings; bridge maps message to verbose why"
```

---

## Task 6: `summary` for the dome.markdown lint diagnostics

**Files:** Modify `assets/extensions/dome.markdown/manifest.yaml` (and/or the processor that emits the message — verify); Test: the relevant extension/markdown test.

- [ ] **Step 1: Locate** where the `dome.markdown` diagnostic messages are authored: `grep -rn "core-memory size lint never fires\|never fires\|declares" assets/extensions/dome.markdown`. Determine whether the human message is built in `manifest.yaml` or in a processor `.ts`. Read the surrounding diagnostic-construction code to learn how to add a `summary` alongside the `message`.

- [ ] **Step 2: Write the failing test** — in the markdown extension test that exercises these diagnostics, assert the emitted diagnostic carries a terse `summary` distinct from `message`. (If no such test exists, add one mirroring `tests/extensions/*` style.)

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — author a one-line `summary` for the highest-traffic `dome.markdown` diagnostics (broken-wikilink, core-size, render-index grant gaps, stale-dates), keeping their full `message` unchanged. If these diagnostics flow through the same `HealthFinding`/diagnostic shape, reuse the `summary` field added in Task 5; if they use a different diagnostic type, add `summary?` to that type additively.

- [ ] **Step 5: Run** the extension test + `bun run typecheck` → green. Confirm `--json` carries both fields.

- [ ] **Step 6: Commit**
```bash
git add assets/extensions/dome.markdown tests/extensions
git commit -m "feat(markdown): author terse summary on high-traffic markdown diagnostics"
```

> If markdown diagnostics turn out NOT to share the finding shape used by check/doctor (i.e. they render elsewhere), STOP and report — the bridge in Task 5 may need a second mapping. Do not force-fit.

---

## Task 7: status — signal-only default + `--verbose` full + footer removal

**Files:** Modify `src/cli/commands/status.ts`; Test `tests/cli/commands/status.test.ts`

- [ ] **Step 1: Read** `printStatusText` (current 5-section dashboard: NEXT, AT A GLANCE, VAULT, ENGINE, DIAGNOSTICS, footer). Identify the snapshot fields that drive each "attention" signal (sync needed, projection stale, dirty draft, diagnostics>0, questions>0, serve stale) and which are "healthy" when not flagged.

- [ ] **Step 2: Write failing tests**

```ts
test("default status shows only attention signals + rollup, no footer rule", () => {
  // snapshot: sync needed + projection stale, everything else clean
  expect(out).toContain("⚠ sync");            // or ascii "! sync" per caps
  expect(out).toContain("⚠ projection");
  expect(out).toContain("everything else clean");
  expect(out).not.toContain("VAULT");          // section headers gone from default
  expect(out).not.toMatch(/^-{10,}/m);         // no full-width rule
  expect(out).not.toContain("DIAGNOSTICS");
});
test("all-clear status is a one-line verdict + fingerprint", () => {
  // snapshot: nothing needs attention
  expect(out).toContain("healthy");
  expect(out.split("\n").filter((l) => l.trim().length > 0).length).toBeLessThanOrEqual(3);
});
test("verbose status restores the full vault + engine breakdown", () => {
  expect(verboseOut).toContain("VAULT");
  expect(verboseOut).toContain("loops");
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — split `printStatusText(snapshot, { verbose, caps })`:
  - **Default:** verdict header (`headline` with verdict `⚠ N need attention` / `✓ healthy`); a single `→` next-action via `nextActions`(humanized); a `signalLine` per attention item (only those flagged); a `rollup` of the healthy categories; a dim `--verbose for full vault + engine` hint when there were attention items. NO sections, NO footer (`rule`/`footer`).
  - **All-clear:** header `✓ healthy` + one fingerprint line (`signalLine("ok", "", "synced just now · 104 pages · nothing pending")` or a plain inset line).
  - **Verbose:** the existing v1 sections (VAULT/ENGINE/loops/content with dimZeros) — keep that code, gated behind `verbose`. Drop the footer in both modes.

- [ ] **Step 5: Run** `bun test tests/cli/commands/status.test.ts` → PASS. Eyeball `bin/dome status --vault docs` and `bin/dome status --vault docs --verbose`. Confirm `--json` unchanged.

- [ ] **Step 6: Commit**
```bash
git add src/cli/commands/status.ts tests/cli/commands/status.test.ts
git commit -m "feat(cli): status default is signal-only; full breakdown behind --verbose; footer removed"
```

---

## Task 8: check — terse findings default + `--verbose` + NEXT fix + footer removal

**Files:** Modify `src/cli/commands/check.ts`; Test `tests/cli/commands/check.test.ts`

- [ ] **Step 1: Read** the current check renderer (NEXT run-on, AT A GLANCE incl. the redundant loops line, ENGINE findings via `findingLines`, footer). Note the `next_actions` source (humanize it) and where the `finding(s)` literal + severity counts come from.

- [ ] **Step 2: Write failing tests**

```ts
test("check NEXT is one humanized line (no --json, no run-on)", () => {
  expect(out).toContain("→ dome sync");
  expect(out).not.toContain("dome sync --json");
  expect(out).not.toContain("finding(s)");
});
test("check default findings are terse; verbose adds the why", () => {
  expect(defaultOut).not.toContain("the core-memory size lint never fires");
  expect(verboseOut).toContain("the core-memory size lint never fires");
});
test("check has no full-width footer rule", () => {
  expect(out).not.toMatch(/^-{10,}/m);
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — verdict header (`⚠ N problems · M notes` where problems=warn+err, notes=info; `✓ all clear` when none); one humanized `→` next-action (run the snapshot's action through `humanizeCommand`; if multiple clauses, keep the single most important — no paragraph); `findingLines(findings, caps, verbose)`; drop AT A GLANCE from default (move to `--verbose`), drop the footer. Under `--verbose`, restore the at-a-glance block + the full finding `why`.

- [ ] **Step 5: Run** `bun test tests/cli/commands/check.test.ts` → PASS. Eyeball default + `--verbose`. `--json` unchanged.

- [ ] **Step 6: Commit**
```bash
git add src/cli/commands/check.ts tests/cli/commands/check.test.ts
git commit -m "feat(cli): check is verdict-first; terse findings; one-line NEXT; footer removed"
```

---

## Task 9: doctor — findings + breakdown→rollup/verbose + footer removal

**Files:** Modify `src/cli/commands/doctor.ts`; Test `tests/cli/commands/doctor.test.ts`

- [ ] **Step 1: Read** the doctor renderer — the FINDINGS section (via `findingLines`) and the AT A GLANCE 19-term breakdown line (the `dimZeros([...])` call).

- [ ] **Step 2: Write failing tests**

```ts
test("doctor default collapses the breakdown to a clean rollup, not 19 terms", () => {
  expect(out).not.toContain("0 stuck");          // zero-terms gone from default
  expect(out).toMatch(/all clean/);              // rollup present
});
test("doctor verbose restores the full breakdown", () => {
  expect(verboseOut).toContain("0 stuck");
});
test("doctor findings terse by default, why under verbose; no footer rule", () => {
  expect(defaultOut).not.toContain("the core-memory size lint never fires");
  expect(verboseOut).toContain("the core-memory size lint never fires");
  expect(out).not.toMatch(/^-{10,}/m);
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — verdict header (`⚠ N problems · M notes` / `✓ healthy`); `findingLines(findings, caps, verbose)`; replace the 19-term `dimZeros` breakdown with a `rollup(cleanCategoryLabels, caps)` in default mode (compute which categories are zero/healthy and pass their names); gate the full `dimZeros` breakdown behind `verbose`; drop the footer.

- [ ] **Step 5: Run** `bun test tests/cli/commands/doctor.test.ts` → PASS. Eyeball default + `--verbose`. `--json` unchanged.

- [ ] **Step 6: Commit**
```bash
git add src/cli/commands/doctor.ts tests/cli/commands/doctor.test.ts
git commit -m "feat(cli): doctor collapses breakdown to a rollup; full detail behind --verbose; footer removed"
```

---

## Task 10: lint — one-line pass + findings + footer/CHECKED removal

**Files:** Modify `src/cli/commands/lint.ts`; Test `tests/cli/commands/lint.test.ts`

- [ ] **Step 1: Read** the lint renderer (CHECKED section with the all-zero issues line, ISSUES section, footer).

- [ ] **Step 2: Write failing tests**

```ts
test("lint pass is a single verdict line", () => {
  // clean fixture
  const nonBlank = out.split("\n").filter((l) => l.trim().length > 0);
  expect(nonBlank.length).toBe(1);
  expect(out).toMatch(/✓ pass — \d+ files, no issues|√ pass — \d+ files, no issues/);
});
test("lint with issues renders findings; no footer rule; CHECKED only under verbose", () => {
  expect(issuesOut).toContain("⚠ ");        // a finding glyph
  expect(issuesOut).not.toMatch(/^-{10,}/m);
  expect(issuesOut).not.toContain("CHECKED");
  expect(verboseOut).toContain("CHECKED");
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — pass case: a single header line `dome lint · docs   ✓ pass — N files, no issues` (no CHECKED/ISSUES/footer). Issues case: verdict header (`⚠ N issues`) + findings via the `finding` primitive (lint issue → Finding: severity/code/subject=path/what=summary??message/fix). Gate the CHECKED breakdown behind `--verbose`. Drop the footer.

- [ ] **Step 5: Run** `bun test tests/cli/commands/lint.test.ts` → PASS. `--json` unchanged.

- [ ] **Step 6: Commit**
```bash
git add src/cli/commands/lint.ts tests/cli/commands/lint.test.ts
git commit -m "feat(cli): lint pass is one line; issues via finding; CHECKED behind --verbose; footer removed"
```

---

## Task 11: query + log — inset + verdict conform (light touch)

**Files:** Modify `src/cli/commands/query.ts`, `src/cli/commands/log.ts`; Test their test files.

- [ ] **Step 1: Read** both renderers. query already uses the `match` primitive + a summary line; log uses relative time + trailer strip. Confirm neither has a `footer`/`rule` call; if either does, remove it.

- [ ] **Step 2: Write failing tests** — assert query has no full-width rule and its header verdict reads `• N matches`; assert log has no full-width rule and a `• N entries` (or similar) verdict if it has a header. (If they're already conformant, these tests pass immediately — in that case assert the current good shape so it's pinned, and note no code change was needed.)

- [ ] **Step 3: Run** → FAIL or PASS-as-pinned.

- [ ] **Step 4: Implement** — remove any `footer`/`rule` usage; ensure the verdict header phrasing is `• N matches`/`• N entries`; confirm the 2-space inset is already present (the `section`/match indentation gives it). Minimal change.

- [ ] **Step 5: Run** their tests → PASS. `--json` unchanged.

- [ ] **Step 6: Commit**
```bash
git add src/cli/commands/query.ts src/cli/commands/log.ts tests/cli/commands/log.test.ts tests/cli/commands/query.test.ts
git commit -m "feat(cli): query/log conform to verdict header, drop footer rules"
```

---

## Task 12: inspect — empty-state collapse + lowercase headers

**Files:** Modify `src/cli/commands/inspect.ts`; Test `tests/cli/commands/inspect.test.ts`

- [ ] **Step 1: Read** the inspect renderer — the table rendering, the `(no rows)` empty path, the `cost` TOTAL block + `no spend` path, and the `…hidden → --json` footnote. Note the column-header casing.

- [ ] **Step 2: Write failing tests**

```ts
test("empty inspect is a single verdict line", () => {
  // questions subject on an empty fixture
  const nonBlank = out.split("\n").filter((l) => l.trim().length > 0);
  expect(nonBlank.length).toBe(1);
  expect(out).toContain("no rows");
});
test("cost no-spend is a single line (no $0.0000 TOTAL block)", () => {
  expect(costOut).toContain("no spend in");
  expect(costOut).not.toContain("$0.0000");
});
test("table column headers are lowercase", () => {
  expect(rowsOut).toContain("processor"); // not "PROCESSOR"
});
```

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** — when a subject has zero rows, render only the verdict header line (`○ no rows` / `○ no spend in 7d`) and drop the `(no rows)`/`TOTAL`/footnote block (those move to `--json`/`--verbose` if desired; for now default = one line). Lowercase the table column headers. Keep the populated-table rendering and the `…hidden → --json` footnote unchanged for non-empty results.

- [ ] **Step 5: Run** `bun test tests/cli/commands/inspect.test.ts` → PASS. Eyeball `bin/dome inspect questions/cost/runs --vault docs`. `--json` unchanged.

- [ ] **Step 6: Commit**
```bash
git add src/cli/commands/inspect.ts tests/cli/commands/inspect.test.ts
git commit -m "feat(cli): inspect empty/cost states collapse to one line; lowercase table headers"
```

---

## Task 13: Remove dead footer/rule usage + verify no command renders a full-width rule

**Files:** Modify any command still importing `footer`/`rule`; possibly `src/cli/presenter/primitives.ts` (leave `footer`/`rule` exported only if still used).

- [ ] **Step 1:** `grep -rn "footer(\|rule(" src/cli/commands` — list every remaining caller. Each restyled command (status/check/doctor/lint) should have none after Tasks 7–10; confirm.

- [ ] **Step 2: Write a guard test** in `tests/cli/commands/` (or extend an existing one) asserting that status/check/doctor/lint output never contains a run of ≥10 `─`/`-` characters (the full-width rule):

```ts
test.each(["status", "check", "doctor", "lint"])("%s renders no full-width rule", (cmd) => {
  // render each with its fixture; assert:
  expect(out).not.toMatch(/[-─]{10,}/);
});
```

- [ ] **Step 3: Run** → should PASS if Tasks 7–10 removed all footers; if any FAILS, remove the stray `footer`/`rule` call.

- [ ] **Step 4:** If `footer`/`rule` now have zero callers anywhere (`grep -rn "footer(\|rule(" src`), leave them exported (harmless) but note it; do NOT delete shared primitives that other surfaces might use. If clearly dead and only used by these commands, deletion is acceptable — verify with grep first.

- [ ] **Step 5: Commit** (if anything changed)
```bash
git add -A
git commit -m "test(cli): guard against full-width rules in status/check/doctor/lint"
```

---

## Task 14: Full-suite verification + doc sync

**Files:** Modify `docs/wiki/specs/cli.md` (output examples), any stale `tests/harness/scenarios/cli-surface/*`.

- [ ] **Step 1:** `bun run typecheck` → MUST be clean (0 errors, all 3 tsconfig invocations).

- [ ] **Step 2:** `bun test 2>&1 | tail -30`. Classify any failure: a stale assertion on OLD human output → update to the new v2 shape; a `--json` assertion failure → that is a BUG to fix (existing JSON fields must be unchanged; only `summary` is additive). Re-run until green except confirmed-pre-existing flaky timing tests (the `runStatus` heartbeat/staleness `--json` tests + `runInit --with-source slack` are known to flake under parallel load — confirm each passes in isolation: `bun test <file>`).

- [ ] **Step 3:** Hand-walk every command in default AND `--verbose` against the docs vault (sync the worktree vault once if it has no adopted ref):
```bash
for c in "status" "status --verbose" "check" "check --verbose" "doctor" "doctor --verbose" "lint" "lint --verbose" "query capability --vault docs" "log" "inspect cost" "inspect questions" "inspect runs" "today"; do echo "### $c"; bin/dome $c --vault docs 2>&1 | head -30; done
```
Confirm: verdict-first headers, no full-width rules, signal-only defaults, rollups, one-line empty/pass states, terse findings + verbose `why`.

- [ ] **Step 4:** Update `docs/wiki/specs/cli.md` output examples to the v2 shapes (status/check/doctor/lint/inspect changed most). Do NOT touch the design/plan docs or `--json` schema docs (beyond noting the additive `summary`).

- [ ] **Step 5: Commit**
```bash
git add -A
git commit -m "test(cli): v2 full-suite green; doc sync to signal-first output"
```

---

## Self-review notes

- **Spec coverage:** verdict-header/no-footer (T7–T13) · inset/breathing (T7–T12) · one next-action humanized (T8) · glyph-led signalLine (T2,T7) · only-non-OK + rollup (T3,T7,T9) · `--verbose` tier (T1,T7–T10) · terse-essence findings + authored summary (T4,T5,T6) · per-command application (T7–T12) · diagnostic `summary` additive to `--json` (T5,T6) · `--json` byte-identity for existing fields (T14 step 2) · empty/all-clear one-line (T7,T10,T12) · testing across caps×verbose (T2–T4). All spec sections map to a task.
- **`--json` safety:** only `summary` is added (T5/T6); T14 step 2 guards existing-field identity and treats any other JSON change as a bug.
- **Type consistency:** `signalLine(tone,label,detail,labelWidth,caps)`, `rollup(cleanLabels,caps)`, `finding(f,caps,verbose=false)`, `Finding.why?`, `findingLines(findings,caps,verbose)`, `HealthFinding.summary?` — defined in T2/T3/T4/T5 and reused by name in T7–T12. `exactOptionalPropertyTypes` honored via conditional spreads (T5 already shows the `...(subject ? {subject} : {})` idiom).
- **Cross-layer reach:** only T5/T6 touch non-CLI code (health.ts + dome.markdown), additively; T6 has an explicit STOP-and-report guard if the markdown diagnostics don't share the finding shape.
