# Inline Task-Origin Links — Phase 1 (Capture Backlinks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every task `dome.agent.ingest` lifts from a raw capture into today's daily carries an inline, clickable backlink to the archived capture file — so a TODO in the daily is always one click from its origin.

**Architecture:** The captured-tasks seam (`capturedAwareAppendTool`) — not the model — stamps a plain-markdown origin marker ` ([↗](inbox/processed/<name>))` onto each spliced task line, placed before any block anchor. Ingest sets the current source's deterministic archived path on the shared routing struct per source-loop iteration; the seam reads it at splice time. The marker becomes ordinary committed markdown (source of truth), so it survives `dome rebuild` for free. A pure `appendOriginMarker(line, target)` helper takes an arbitrary target string, so Phase 2 (Slack permalinks) reuses it with zero new shape.

**Tech Stack:** TypeScript on Bun; `bun test`; first-party extension bundles under `assets/extensions/` (`dome.agent`, `dome.daily`); pure core grammar under `src/core/`.

**Design:** `docs/cohesive/brainstorms/2026-06-15-task-origin-links.md` (approved 2026-06-15).

---

### Task 1: Extract the deterministic archive-path rewrite

The raw→processed rewrite is currently inlined in `archiveSourceTool`. Ingest's per-source origin stamping (Task 4) needs the same rewrite. Extract one pure helper both share so they can never disagree on where a capture lands.

**Files:**
- Modify: `assets/extensions/dome.agent/lib/vault-tools.ts` (add export near `archiveSourceTool`, ~line 237; refactor `archiveSourceTool` body, ~line 247-261)
- Test: `tests/extensions/dome.agent/ingest-tools.test.ts` (add a `describe("archivedCapturePath", …)` block)

- [ ] **Step 1: Write the failing test**

Add to `tests/extensions/dome.agent/ingest-tools.test.ts` (import `archivedCapturePath` from the vault-tools module at the top alongside existing imports):

```ts
import { archivedCapturePath } from "../../../assets/extensions/dome.agent/lib/vault-tools";

describe("archivedCapturePath", () => {
  test("rewrites inbox/raw to inbox/processed, preserving the basename", () => {
    expect(archivedCapturePath("inbox/raw/2026-06-14-jane.md")).toBe(
      "inbox/processed/2026-06-14-jane.md",
    );
  });

  test("returns null for paths outside inbox/raw", () => {
    expect(archivedCapturePath("wiki/concepts/a.md")).toBeNull();
    expect(archivedCapturePath("inbox/processed/x.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/dome.agent/ingest-tools.test.ts -t archivedCapturePath`
Expected: FAIL — `archivedCapturePath` is not exported (import error / undefined).

- [ ] **Step 3: Add the helper and refactor `archiveSourceTool` to use it**

In `assets/extensions/dome.agent/lib/vault-tools.ts`, add the exported helper immediately above `archiveSourceTool`:

```ts
/**
 * The deterministic raw→processed archive-path rewrite. Returns null for
 * paths outside `inbox/raw/` (the only sources `archiveSource` moves).
 * Shared by `archiveSourceTool` and ingest's per-source origin stamping so
 * the marker target and the archive destination can never disagree.
 */
export function archivedCapturePath(rawPath: string): string | null {
  if (!rawPath.startsWith("inbox/raw/")) return null;
  return rawPath.replace(/^inbox\/raw\//, "inbox/processed/");
}
```

Then change the body of `archiveSourceTool`'s `execute` from:

```ts
      if (!rawPath.startsWith("inbox/raw/")) {
        return `error: archiveSource only archives inbox/raw/ sources; got ${rawPath}.`;
      }
      const processedPath = rawPath.replace(/^inbox\/raw\//, "inbox/processed/");
```

to:

```ts
      const processedPath = archivedCapturePath(rawPath);
      if (processedPath === null) {
        return `error: archiveSource only archives inbox/raw/ sources; got ${rawPath}.`;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/dome.agent/ingest-tools.test.ts`
Expected: PASS — the new `archivedCapturePath` tests pass and the existing `archiveSource deletes the raw path and writes a processed copy` test still passes (behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.agent/lib/vault-tools.ts tests/extensions/dome.agent/ingest-tools.test.ts
git commit -m "refactor(dome.agent): extract archivedCapturePath helper from archiveSourceTool"
```

---

### Task 2: The `appendOriginMarker` grammar helper

A pure helper that stamps the origin marker onto a task line, before any trailing block anchor, idempotently. Lives with the other captured-task-line grammar in `captured-block.ts`. Reuses the canonical block-anchor matcher (`parseBlockAnchor`) so placement honors the real `^id` grammar.

**Files:**
- Modify: `assets/extensions/dome.daily/processors/captured-block.ts` (add import of `parseBlockAnchor`; add `ORIGIN_MARKER_RE` + `appendOriginMarker` near the other helpers, ~after line 81)
- Test: `tests/extensions/daily-captured.test.ts` (add a `describe("appendOriginMarker", …)` block)

- [ ] **Step 1: Write the failing test**

Add to `tests/extensions/daily-captured.test.ts` (extend the existing import from `captured-block` to include `appendOriginMarker`):

```ts
import { appendOriginMarker } from "../../assets/extensions/dome.daily/processors/captured-block";

describe("appendOriginMarker", () => {
  test("appends a clickable marker to a bare task line", () => {
    expect(
      appendOriginMarker("- [ ] #task reply to Jane", "inbox/processed/2026-06-14-jane.md"),
    ).toBe("- [ ] #task reply to Jane ([↗](inbox/processed/2026-06-14-jane.md))");
  });

  test("places the marker before a trailing block anchor", () => {
    expect(
      appendOriginMarker("- [ ] #task reply to Jane ^a1b2", "inbox/processed/x.md"),
    ).toBe("- [ ] #task reply to Jane ([↗](inbox/processed/x.md)) ^a1b2");
  });

  test("is idempotent — a line already carrying a marker is unchanged", () => {
    const already = "- [ ] #task reply ([↗](inbox/processed/x.md))";
    expect(appendOriginMarker(already, "inbox/processed/y.md")).toBe(already);
  });

  test("an empty target leaves the line unchanged", () => {
    expect(appendOriginMarker("- [ ] #task reply", "")).toBe("- [ ] #task reply");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/daily-captured.test.ts -t appendOriginMarker`
Expected: FAIL — `appendOriginMarker` is not exported.

- [ ] **Step 3: Implement the helper**

In `assets/extensions/dome.daily/processors/captured-block.ts`, add to the existing `src/core` imports:

```ts
import { parseBlockAnchor } from "../../../../src/core/block-anchor";
```

Then add, after `isCapturedTaskLine` (~line 81):

```ts
/**
 * Matches an already-present inline origin marker ` ([↗](target))`. Keyed on
 * the `↗` marker shape — NOT on the target — so a marker is detected whether
 * its target is a vault path (Phase 1) or an external URL (Phase 2 / Slack).
 */
export const ORIGIN_MARKER_RE = /\(\[↗\]\([^)]*\)\)/;

/**
 * Stamp the inline task-origin marker ` ([↗](target))` onto a captured task
 * line, placed after the description and before any trailing block anchor (so
 * `dome.daily.stamp-block-id` / `normalize-task-syntax` keep the anchor as the
 * trailing token). Idempotent: a line already carrying a marker, or an empty
 * target, is returned unchanged. `target` is any string — a vault-relative
 * path (Phase 1) or an external URL (Phase 2) — so the seam serves both
 * origins with one grammar. Spec: [[wiki/specs/daily-surface]] §"The ingest
 * tool seam".
 */
export function appendOriginMarker(line: string, target: string): string {
  if (target === "" || ORIGIN_MARKER_RE.test(line)) return line;
  const parsed = parseBlockAnchor(line);
  if (parsed !== null) {
    return `${parsed.withoutAnchor} ([↗](${target})) ^${parsed.id}`;
  }
  return `${line.trimEnd()} ([↗](${target}))`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/daily-captured.test.ts -t appendOriginMarker`
Expected: PASS — all four cases pass.

- [ ] **Step 5: Verify the marker survives `isCapturedTaskLine`**

A marker-bearing line must still validate as a captured task line (the extractors re-check it). Add this regression test to the same `describe` block:

```ts
test("a marker-bearing line is still a valid captured task line", () => {
  const line = appendOriginMarker("- [ ] #task reply", "inbox/processed/x.md");
  expect(isCapturedTaskLine(line)).toBe(true);
});
```

Run: `bun test tests/extensions/daily-captured.test.ts -t appendOriginMarker`
Expected: PASS — confirms the `([↗](…))` marker does not trip `SOURCE_BACKED_SUFFIX_RE` (which requires literal `(from [[…]])`) or the HTML-comment guard. (`isCapturedTaskLine` is already imported in this test file.)

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.daily/processors/captured-block.ts tests/extensions/daily-captured.test.ts
git commit -m "feat(dome.daily): appendOriginMarker — inline task-origin marker grammar"
```

---

### Task 3: Stamp the marker in the captured-tasks seam

Wire an `origin` field onto `CapturedTasksRouting` and have `capturedAwareAppendTool` stamp it onto each validated line before splicing. The marker is added *after* the size/shape validation, so `CAPTURED_LINE_MAX_CHARS` measures only the model-authored text.

**Files:**
- Modify: `assets/extensions/dome.agent/lib/ingest-tools.ts` (add `origin` to `CapturedTasksRouting` ~line 57; import `appendOriginMarker`; map lines in `capturedAwareAppendTool` before `appendCapturedTaskLines`, ~line 156)
- Test: `tests/extensions/dome.agent/ingest-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/extensions/dome.agent/ingest-tools.test.ts`. Compute today's daily path the same way the existing seam tests do (via `dailyPath`/`dailyPathSettings`, already imported). Add a helper and test:

```ts
import { localDateParts } from "../../../assets/extensions/dome.daily/processors/daily-paths";

describe("captured seam origin marker", () => {
  const settings = dailyPathSettings(undefined);
  const today = localDateParts(new Date("2026-06-14T15:00:00.000Z"));
  const dailyP = dailyPath(today, settings);

  test("stamps the origin marker onto each spliced task line", async () => {
    const tools = makeIngestTools({
      reader: reader({}),
      capturedTasks: {
        path: dailyP,
        today,
        settings,
        origin: "inbox/processed/2026-06-14-jane.md",
      },
    });
    const t = tool(tools, "appendToPage");
    const state = freshState();
    await t.execute(
      { path: dailyP, content: "- [ ] #task reply to Jane" },
      state,
    );
    const edit = state.edits.get(dailyP);
    expect(edit?.kind === "write" && edit.content).toContain(
      "- [ ] #task reply to Jane ([↗](inbox/processed/2026-06-14-jane.md))",
    );
  });

  test("no marker when origin is null", async () => {
    const tools = makeIngestTools({
      reader: reader({}),
      capturedTasks: { path: dailyP, today, settings, origin: null },
    });
    const t = tool(tools, "appendToPage");
    const state = freshState();
    await t.execute({ path: dailyP, content: "- [ ] #task plain" }, state);
    const edit = state.edits.get(dailyP);
    expect(edit?.kind === "write" && edit.content).toContain("- [ ] #task plain");
    expect(edit?.kind === "write" && edit.content).not.toContain("↗");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/dome.agent/ingest-tools.test.ts -t "captured seam origin marker"`
Expected: FAIL — `origin` is not a property of `CapturedTasksRouting` (type error), and the marker is absent from the spliced output.

- [ ] **Step 3: Add the `origin` field and stamp in the seam**

In `assets/extensions/dome.agent/lib/ingest-tools.ts`, extend the import from `captured-block` (line 2-8) to add `appendOriginMarker`:

```ts
import {
  appendCapturedTaskLines,
  appendOriginMarker,
  CAPTURED_APPEND_MAX_LINES,
  CAPTURED_LINE_MAX_CHARS,
  isCapturedTaskLine,
  isValidCapturedTasksWrite,
} from "../../dome.daily/processors/captured-block";
```

Add the `origin` field to `CapturedTasksRouting` (after `settings`, ~line 61). It is **optional** so the existing `ingest.ts` literal (which does not set it until Task 4) still compiles — every commit stays green:

```ts
export type CapturedTasksRouting = {
  /** Today's daily note path — the only daily ingest may write. */
  readonly path: string;
  readonly today: DailyDate;
  readonly settings: DailyPathSettings;
  /**
   * Mutable per-source origin target the seam stamps onto each spliced task
   * line as an inline ` ([↗](origin))` marker. Ingest sets it to the current
   * capture's archived path before each source-loop iteration; absent/null =
   * no marker. Phase 2 sets it to an external (Slack) permalink instead.
   */
  origin?: string | null;
};
```

In `capturedAwareAppendTool`, replace the single splice line (currently `const next = appendCapturedTaskLines({ content: target, lines });`, ~line 156) with a stamp-then-splice (`?? null` collapses both undefined and null to "no marker"):

```ts
      const origin = capturedTasks.origin ?? null;
      const stamped =
        origin === null
          ? lines
          : lines.map((line) => appendOriginMarker(line, origin));
      const next = appendCapturedTaskLines({ content: target, lines: stamped });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/dome.agent/ingest-tools.test.ts`
Expected: PASS — both new cases pass and all existing seam tests still pass. Because `origin` is optional, existing `capturedTasks` literals that omit it compile unchanged and behave as "no marker".

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.agent/lib/ingest-tools.ts tests/extensions/dome.agent/ingest-tools.test.ts
git commit -m "feat(dome.agent): captured seam stamps inline origin marker on task lines"
```

---

### Task 4: Set the per-source origin in the ingest processor

The seam reads `capturedTasks.origin`; ingest must set it to the current capture's archived path before running the agent loop for that source.

**Files:**
- Modify: `assets/extensions/dome.agent/processors/ingest.ts` (initialize `origin: null` at the routing literal ~line 62; set `capturedTasks.origin` at the top of the source loop ~line 86; import `archivedCapturePath`)
- Test: `tests/extensions/dome.agent/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

`ingest.test.ts` uses a `makeCtx` harness whose `steps` script the model's tool calls; `ingest.run(ctx)` returns the effects, and the resulting `PatchEffect.changes` array holds `{ path, content }` per edit (see the existing `emits one PatchEffect…` test, ingest.test.ts:97). `now()` is fixed at `2026-06-08T12:00:00Z`, and the default daily path is `wiki/dailies/<date>.md`. Add:

```ts
test("a lifted captured task carries a backlink to the archived capture", async () => {
  const raw = "inbox/raw/2026-06-08-jane.md";
  const expectedDate = formatDate(localDateParts(new Date("2026-06-08T12:00:00Z")));
  const dailyP = `wiki/dailies/${expectedDate}.md`;
  const ctx = makeCtx({
    files: { [raw]: "remember to reply to Jane" },
    changedPaths: [raw],
    steps: [
      {
        toolCalls: [
          { id: "1", name: "appendToPage", input: { path: dailyP, content: "- [ ] #task reply to Jane" } },
          { id: "2", name: "archiveSource", input: { rawPath: raw } },
        ],
      },
      { text: "ingested" },
    ],
  });
  const effects = await ingest.run(ctx);
  const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
  const daily = patch.changes.find((c) => String(c.path) === dailyP);
  expect(daily).toBeDefined();
  expect(String(daily!.content)).toContain(
    "- [ ] #task reply to Jane ([↗](inbox/processed/2026-06-08-jane.md))",
  );
});
```

(`formatDate` and `localDateParts` are already imported at the top of the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts -t backlink`
Expected: FAIL — the daily change exists and contains `- [ ] #task reply to Jane`, but without the `([↗](inbox/processed/2026-06-08-jane.md))` marker (`origin` is never set on the routing struct).

- [ ] **Step 3: Wire the origin into the loop**

In `assets/extensions/dome.agent/processors/ingest.ts`, add the import (with the other `../lib/...` imports):

```ts
import { archivedCapturePath } from "../lib/vault-tools";
```

The `capturedTasks` literal (~line 62) needs no change — `origin` is optional. At the top of the source loop, after the `if (source === null) continue;` line (~line 87), set the current source's origin (overwritten each iteration, so a non-`inbox/raw` source resets it to null):

```ts
      // The marker target for tasks lifted from THIS source: the path the
      // file will occupy after archiveSource moves it out of inbox/raw.
      // Deterministic, so the link never points at the soon-deleted raw path.
      capturedTasks.origin = archivedCapturePath(sourcePath);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts -t backlink`
Expected: PASS — today's daily carries the `([↗](inbox/processed/2026-06-14-jane.md))` backlink.

- [ ] **Step 5: Run the full ingest + captured suites**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts tests/extensions/dome.agent/ingest-tools.test.ts tests/extensions/daily-captured.test.ts tests/harness/scenarios/cli-surface/capture-ingest-captured-block.scenario.test.ts`
Expected: PASS — all green. If the harness scenario asserts exact daily content, update its expected fixture to include the marker.

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.agent/processors/ingest.ts tests/extensions/dome.agent/ingest.test.ts
git commit -m "feat(dome.agent): ingest stamps captured tasks with archived-capture backlink"
```

---

### Task 5: Document the marker in the normative spec

The captured seam is normative at `daily-surface.md` §"The ingest tool seam". Per the repo's doc-sweep rule, normative behavior changes update the spec.

**Files:**
- Modify: `docs/wiki/specs/daily-surface.md` (§"The ingest tool seam")
- Modify: `docs/wiki/specs/capture.md` (the `## The landing zone` paragraph that describes the task origin)

- [ ] **Step 1: Locate the seam section**

Run: `grep -n "ingest tool seam\|captured seam\|#task" docs/wiki/specs/daily-surface.md`
Note the line of the "The ingest tool seam" heading.

- [ ] **Step 2: Add the normative paragraph**

Under that section, add:

```markdown
**Origin marker.** When the seam splices a captured task line, it stamps an
inline origin marker — ` ([↗](target))`, plain markdown, placed after the
description and before any block anchor — naming where the task came from. In
Phase 1 the target is the capture's *archived* path
(`inbox/processed/<name>`), computed deterministically by the processor (never
the model) so the link cannot point at the soon-deleted `inbox/raw/` path. The
marker is excluded from the `CAPTURED_LINE_MAX_CHARS` cap (which measures the
model-authored text), is idempotent (a line already carrying a marker is left
alone), and becomes ordinary source-of-truth markdown — so it survives
`dome rebuild`. The grammar takes an arbitrary target, so a future external
origin (a Slack permalink) reuses the same marker with no new shape. Design:
[[cohesive/brainstorms/2026-06-15-task-origin-links]].
```

- [ ] **Step 3: Add a one-line pointer in capture.md**

In `docs/wiki/specs/capture.md`, in the `## The landing zone` paragraph (after "the line is an ordinary task *origin*"), add a sentence:

```markdown
The captured seam also stamps an inline ` ([↗](inbox/processed/<name>))`
backlink to the archived capture on each lifted task line, so a TODO in the
daily is one click from the thought it came from ([[daily-surface]] §"The
ingest tool seam").
```

- [ ] **Step 4: Verify no doc-lint regressions**

Run: `bun test tests/integration` 2>&1 | tail -20`
Expected: PASS — no `no-retired-symbol-names`, substrate-count, or wikilink-resolution failures from the edits. (The brainstorm wikilink resolves because the file exists from the design commit.)

- [ ] **Step 5: Commit**

```bash
git add docs/wiki/specs/daily-surface.md docs/wiki/specs/capture.md
git commit -m "docs(daily,capture): document the inline task-origin marker (Phase 1)"
```

---

### Task 6: Full suite + branch finish

- [ ] **Step 1: Run the full test suite**

Run: `bun test`
Expected: PASS — entire suite green (invariants, integration, processors, captured-block, ingest, harness scenarios).

- [ ] **Step 2: Manual smoke (optional but recommended)**

Run a real capture→ingest cycle against a scratch vault and eyeball today's daily for the clickable `↗` marker. See `getting-started.md` for the scratch-vault recipe; ingest requires `dome.agent` enabled + a ready model.

- [ ] **Step 3: Finish the branch**

Invoke the `superpowers:finishing-a-development-branch` skill to choose merge/PR. Per the repo branch-flow rule, the merge into `main` is `--no-ff`, and the live `dome serve` needs a restart to pick up the new processor code.

---

## Phase 2 (deferred — NOT in this plan)

Slack permalinks. Already de-risked in the design (`docs/cohesive/brainstorms/2026-06-15-task-origin-links.md` §"Phase 2"). When picked up: extend the `slack-day` grammar with an optional trailing permalink, teach `claude-slack.sh` to emit it, and set `capturedTasks.origin` to the model-supplied permalink (guarded to `https://…slack.com/…`). The seam, `appendOriginMarker`, and the marker grammar are already Phase-2-ready — no changes needed here.
```

