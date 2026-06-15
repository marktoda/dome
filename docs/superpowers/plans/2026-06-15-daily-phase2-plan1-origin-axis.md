# Daily Phase 2 — Plan 1: Origin Axis (cohesion core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a daily task's "origin" one coherent thing — one `([↗](target))` grammar (vault path or external URL), one `)`-safe primitive, a structured field on the task, and one clickable `↗` render in `dome today` for capture and Slack alike — and make Slack permalinks available.

**Architecture:** Consolidate the marker grammar into `action-extraction.ts` (the lower module; captured-block re-exports), percent-encoding `()` in the target so parse/strip stay `[^)]*`-simple. `task-index` keeps the marker in the projected body; the identity/dedup/reconcile key functions strip it; `action-state` parses it into `DailyTaskItem.origin`; `today.ts` renders it as one `↗` (OSC 8 to the URL, or `file://<abs>` for a vault path). Slack-day grammar + `claude-slack.sh` gain optional per-entry permalinks; ingest stamps a URL target for URL-bearing captures.

**Tech Stack:** TypeScript on Bun; `bun test`; `dome.daily` + `dome.agent` extension bundles; the CLI presenter (OSC 8 hyperlinks from Phase 1).

**Design:** `docs/cohesive/brainstorms/2026-06-15-daily-phase2.md` (approved 2026-06-15), §"P1".

**Key facts (verified):**
- Marker today: `appendOriginMarker(line, target)` + `ORIGIN_MARKER_RE = /\(\[↗\]\(/` in `captured-block.ts`; `stripOriginMarker` + `ORIGIN_MARKER_BODY_RE = /\s*\(\[↗\]\([^)]*\)\)/` in `action-extraction.ts`. The strip regex breaks on a target containing `)`.
- Dependency direction: `captured-block.ts` imports from `action-extraction.ts` (so the canonical primitive must live in action-extraction).
- `captured-block.ts`'s `appendOriginMarker` is imported by `dome.agent/lib/ingest-tools.ts`.
- Task facts (`OPEN_TASK_PREDICATE`/`FOLLOWUP_PREDICATE`, defined in `action-state.ts`) are emitted by `task-index.ts` (object.value = `task.body`, stripped today) and read only by `action-state.ts` (`taskItemFromFact`, `taskItemFromDailySurface` → `DailyTaskItem`).
- `task-index` computes `taskStableId({ sourcePath, body, anchor? })` from the body; identity is `^id`-anchored once stamped.
- `today.ts` renders task rows via `renderRow` using `splitInlineLinks` + `hyperlink` + `shortenLabel` (Phase 1).
- `TodayTaskRow` (today-view.ts) currently: `{ text, path, line, dueDate }`.
- The brief parses Slack via `parseSlackDigest` (entry shape `[#chan] HH:MM author: "text"`).

---

### Task 1: Consolidate the origin-marker primitive in `action-extraction.ts` (one `)`-safe grammar)

**Files:**
- Modify: `assets/extensions/dome.daily/processors/action-extraction.ts`
- Modify: `assets/extensions/dome.daily/processors/captured-block.ts` (move `appendOriginMarker`/`ORIGIN_MARKER_RE` out; re-export from action-extraction)
- Test: `tests/extensions/daily-captured.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/extensions/daily-captured.test.ts` (import from action-extraction):

```ts
import {
  appendOriginMarker,
  parseOriginMarker,
  stripOriginMarker,
} from "../../assets/extensions/dome.daily/processors/action-extraction";

describe("origin marker primitive", () => {
  test("append + parse round-trips a plain vault path", () => {
    const line = appendOriginMarker("- [ ] #task fix it", "inbox/processed/x.md");
    expect(line).toBe("- [ ] #task fix it ([↗](inbox/processed/x.md))");
    expect(parseOriginMarker(line)).toEqual({ body: "- [ ] #task fix it", target: "inbox/processed/x.md" });
  });
  test("percent-encodes ( and ) in the target so a URL with parens is safe", () => {
    const url = "https://x.example/a(b)";
    const line = appendOriginMarker("- [ ] #task reply", url);
    expect(line).toContain("%28");
    expect(line).toContain("%29");
    // parse decodes back to the original URL
    expect(parseOriginMarker(line)!.target).toBe(url);
    // strip removes the whole marker, leaving the clean body
    expect(stripOriginMarker(line)).toBe("- [ ] #task reply");
  });
  test("strip on a marker-free line is a no-op", () => {
    expect(stripOriginMarker("- [ ] #task plain")).toBe("- [ ] #task plain");
  });
  test("append is idempotent (line already carrying a marker is unchanged)", () => {
    const once = appendOriginMarker("- [ ] #task reply", "inbox/processed/x.md");
    expect(appendOriginMarker(once, "inbox/processed/y.md")).toBe(once);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/daily-captured.test.ts -t "origin marker primitive"`
Expected: FAIL — `parseOriginMarker` not exported; percent-encoding absent.

- [ ] **Step 3: Implement the primitive in `action-extraction.ts`**

Replace the existing `ORIGIN_MARKER_BODY_RE` + `stripOriginMarker` block (around lines 33-37) with the full primitive. Add `import { parseBlockAnchor } from "../../../../src/core/block-anchor";` if not already imported.

```ts
// ── The origin marker — ([↗](target)) — a task's source provenance ──────────
// Canonical home (captured-block re-exports for its callers). The target is
// percent-encoded on ( and ) so the body regex stays [^)]*-simple even for
// URLs containing parentheses.
export const ORIGIN_MARKER_RE = /\(\[↗\]\(/; // detection (opening syntax)
const ORIGIN_MARKER_FULL_RE = /\s*\(\[↗\]\(([^)]*)\)\)/; // capture the encoded target

function encodeTarget(target: string): string {
  return target.replace(/\(/g, "%28").replace(/\)/g, "%29");
}
function decodeTarget(target: string): string {
  return target.replace(/%28/g, "(").replace(/%29/g, ")");
}

/** Stamp ` ([↗](target))` onto a task line, before any trailing ^anchor.
 *  Idempotent; empty target is a no-op; ( and ) in target are percent-encoded. */
export function appendOriginMarker(line: string, target: string): string {
  if (target === "" || ORIGIN_MARKER_RE.test(line)) return line;
  const encoded = encodeTarget(target);
  const parsed = parseBlockAnchor(line);
  if (parsed !== null) return `${parsed.withoutAnchor} ([↗](${encoded})) ^${parsed.id}`;
  return `${line.trimEnd()} ([↗](${encoded}))`;
}

/** Remove the origin marker from a string (body or whole line). No-op if absent. */
export function stripOriginMarker(body: string): string {
  return body.replace(ORIGIN_MARKER_FULL_RE, "");
}

/** Parse the origin out of a line: { body (marker removed), target (decoded) }, or null. */
export function parseOriginMarker(line: string): { readonly body: string; readonly target: string } | null {
  const m = ORIGIN_MARKER_FULL_RE.exec(line);
  if (m === null || m[1] === undefined) return null;
  return Object.freeze({ body: stripOriginMarker(line), target: decodeTarget(m[1]) });
}
```

- [ ] **Step 4: Move the marker out of `captured-block.ts` and re-export**

In `captured-block.ts`, delete the local `ORIGIN_MARKER_RE` const and the `appendOriginMarker` function (lines ~89, ~103-110). Add a re-export near its other imports from action-extraction:

```ts
export { appendOriginMarker, ORIGIN_MARKER_RE } from "./action-extraction";
```

(captured-block already imports other names from action-extraction, so this keeps `dome.agent/lib/ingest-tools.ts`'s `import { appendOriginMarker } from "…/captured-block"` working unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/extensions/daily-captured.test.ts tests/extensions/dome.agent/ingest-tools.test.ts`
Expected: PASS — the new primitive tests pass; ingest-tools (which imports `appendOriginMarker` via captured-block) still passes; existing capture-marker tests pass. Note: existing tests asserting the bare (un-encoded) marker for paths without parens still pass — vault paths contain no `(`/`)`, so encoding is a no-op for them.

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.daily/processors/action-extraction.ts assets/extensions/dome.daily/processors/captured-block.ts tests/extensions/daily-captured.test.ts
git commit -m "refactor(dome.daily): one )-safe origin-marker primitive (parse/strip/append) in action-extraction"
```

---

### Task 2: Carry origin through extraction without polluting identity

The marker must reach the view but never enter identity/dedup/reconcile keys. Today `taskBodyFromCheckboxLine` strips the marker (good for keys) — but that strip also feeds the projected fact body and display, which is why capture origins vanish from `today`. Split the two: a **stripped key body** and a **marker-bearing display body**, plus an extracted `origin`.

**Files:**
- Modify: `assets/extensions/dome.daily/processors/action-extraction.ts` (`MarkdownActionItem`/`OpenTask` gain `origin?: string`; `actionItemsFromMarkdown`/`openTasksFromMarkdown` populate it; `taskBodyFromCheckboxLine` stays stripped for keys)
- Test: `tests/extensions/daily-captured.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { actionItemsFromMarkdown } from "../../assets/extensions/dome.daily/processors/action-extraction";

describe("action items carry origin", () => {
  test("a captured task exposes its origin target, body stays marker-free", () => {
    const md = "## Captured today\n\n- [ ] #task reply to Jane ([↗](https://uniswapteam.slack.com/archives/C0/p1)) ^t1a2b3c4\n";
    const items = actionItemsFromMarkdown(md);
    const item = items.find((i) => i.body.includes("reply to Jane"))!;
    expect(item.body).toBe("reply to Jane"); // marker stripped from semantic body
    expect(item.origin).toBe("https://uniswapteam.slack.com/archives/C0/p1");
  });
  test("a task with no marker has undefined origin", () => {
    const md = "- [ ] #task plain ^t9z9z9z9\n";
    const items = actionItemsFromMarkdown(md);
    expect(items[0]!.origin).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/daily-captured.test.ts -t "carry origin"`
Expected: FAIL — `item.origin` is undefined (not populated).

- [ ] **Step 3: Implement**

Add `readonly origin?: string;` to the `MarkdownActionItem` and `OpenTask` types. In the item-construction site (around line 334, where `body: taskBodyFromCheckboxLine(line)` is set), also compute the origin from the RAW line:

```ts
// near where each item is built from `line`:
const originParsed = parseOriginMarker(line);
return {
  // …existing fields…
  body: taskBodyFromCheckboxLine(line), // already strips the marker
  ...(originParsed !== null ? { origin: originParsed.target } : {}),
};
```

`taskBodyFromCheckboxLine` already calls `stripOriginMarker`, so the key body is unchanged. `taskStableId`, dedup (`normalizeOpenLoopBody`/`semanticActionBody`), and reconcile keys all consume `body`, so identity is unaffected.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/daily-captured.test.ts`
Expected: PASS — origin populated; bodies marker-free; stable-id tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.daily/processors/action-extraction.ts tests/extensions/daily-captured.test.ts
git commit -m "feat(dome.daily): action items expose origin (parsed from marker; body stays marker-free)"
```

---

### Task 3: Thread origin onto the task fact and the daily-surface item

`task-index` must preserve origin into the fact (the only carrier to the backlog view stream), and `action-state` must read it onto `DailyTaskItem`.

**Files:**
- Modify: `assets/extensions/dome.daily/processors/task-index.ts` (encode origin into the fact)
- Modify: `assets/extensions/dome.daily/processors/action-state.ts` (`DailyTaskItem` gains `origin?`; both item builders set it)
- Test: `tests/extensions/daily-today-view.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/extensions/daily-today-view.test.ts` (which exercises the today view end-to-end against a fixture), add a task whose line carries a Slack origin marker and assert the structured view's task row exposes the origin. (Read the file's existing fixture helper to match its style; the assertion is the new part.)

```ts
test("today view exposes a task's origin target", async () => {
  // fixture: a daily with `- [ ] #task reply to Jane ([↗](https://slk/p1)) ^t1a2b3c4`
  // (use the file's existing vault/render helper)
  const view = await renderTodayViewForFixture(/* … */);
  const row = view.openTasks.find((t) => t.text.includes("reply to Jane"))!;
  expect(row.origin).toBe("https://slk/p1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/daily-today-view.test.ts -t origin`
Expected: FAIL — `row.origin` is undefined.

- [ ] **Step 3: Implement — fact carrier**

In `task-index.ts`, the fact `object.value` is the stripped `task.body`. To carry origin, append the marker back onto the fact value ONLY (keeping the key/stableId on the stripped body, which it already uses):

```ts
const objectValue = task.origin !== undefined
  ? appendOriginMarker(task.body, task.origin)
  : task.body;
// …
object: { kind: "string", value: objectValue },
```

Import `appendOriginMarker` from `./action-extraction`. The `stableId` is still computed from `task.body` (stripped) above — unchanged, so identity is stable. (The marker rides the fact value; `action-state` parses it back.)

- [ ] **Step 4: Implement — view readers**

In `action-state.ts`: add `readonly origin?: string;` to `DailyTaskItem`. In `taskItemFromFact`, parse origin from the fact value and use the stripped body for everything else:

```ts
const parsed = parseOriginMarker(factValue);            // factValue = fact.object string
const body = parsed?.body ?? stripOriginMarker(factValue);
const origin = parsed?.target;
// build the item with `body` (marker-free) and `...(origin ? { origin } : {})`
```

In `taskItemFromDailySurface`, the source markdown item already has `.origin` (Task 2) — pass it through: `...(item.origin !== undefined ? { origin: item.origin } : {})`.

Import `parseOriginMarker`, `stripOriginMarker` from `./action-extraction`.

- [ ] **Step 5: Implement — view row**

In `today-view.ts`, add `readonly origin?: string;` to `TodayTaskRow`, and in `parseTaskRows` read it: `const origin = typeof r.origin === "string" ? r.origin : undefined;` and include `...(origin !== undefined ? { origin } : {})`. The `dome.daily.today/v1` structured payload must include `origin` per task row — find where `action-state` items are serialized into the view document and add `origin` to each task row's serialized shape.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/extensions/daily-today-view.test.ts tests/surface/today-view.test.ts tests/extensions/daily-captured.test.ts`
Expected: PASS — origin flows fact → item → view row; identity/dedup tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add assets/extensions/dome.daily/processors/task-index.ts assets/extensions/dome.daily/processors/action-state.ts src/surface/today-view.ts tests/extensions/daily-today-view.test.ts
git commit -m "feat(dome.daily): thread task origin through fact → item → today view row"
```

---

### Task 4: Render origin as one clickable `↗` in `dome today`

**Files:**
- Modify: `src/cli/commands/today.ts` (`renderRow` renders `row.origin`)
- Modify: `src/cli/presenter/links.ts` (helper to turn a vault path into a `file://` URL)
- Test: `tests/cli/commands/today.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("today renders task origin as one affordance", () => {
  const caps = { color: false, unicode: true, width: 80, hyperlinks: true } as const;
  const doc = (over = {}) => ({
    date: "2026-06-15",
    openTasks: [
      { text: "reply to Jane re: pricing", path: "p", line: 1, dueDate: "2026-06-13", origin: "https://slk/p1" },
      { text: "fix the radiator", path: "p", line: 2, dueDate: "2026-06-13", origin: "inbox/processed/2026-06-14-radiator.md" },
    ],
    followups: [], questions: [], counts: { openTasks: 2, followups: 0, questions: 0 },
    hero: null, brief: null, calendar: null, ...over,
  });
  test("a URL origin renders one ↗ hyperlink to the URL", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).toContain("\x1b]8;;https://slk/p1\x1b\\↗\x1b]8;;\x1b\\");
    expect(out).not.toContain("https://slk/p1\x1b\\↗\x1b]8;;\x1b\\↗"); // no double arrow
  });
  test("a vault-path origin renders a file:// ↗ hyperlink", () => {
    const out = formatTodayResult(doc(), caps, "/v/work");
    expect(out).toContain("file:///v/work/inbox/processed/2026-06-14-radiator.md");
  });
  test("no origin → no affordance", () => {
    const out = formatTodayResult(doc({ openTasks: [{ text: "bare task", path: "p", line: 1, dueDate: "2026-06-13" }], counts: { openTasks: 1, followups: 0, questions: 0 } }), caps, "/v/work");
    const line = out.split("\n").find((l) => l.includes("bare task"))!;
    expect(line).not.toContain("↗");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/cli/commands/today.test.ts -t "renders task origin"`
Expected: FAIL — origin not rendered.

- [ ] **Step 3: Implement the `file://` helper**

In `src/cli/presenter/links.ts`:

```ts
/** Resolve a task origin target to a clickable URL: external URLs pass through;
 *  vault-relative paths become file://<vaultAbsPath>/<path>. */
export function originUrl(target: string, vaultAbs: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return target; // already a URL
  const clean = target.replace(/^\.?\/+/, "");
  return `file://${vaultAbs.replace(/\/+$/, "")}/${clean}`;
}
```

- [ ] **Step 4: Implement the render**

In `today.ts` `renderRow`, after computing the shortened `label`, append the origin affordance. Reserve width for it (one `↗` = `visibleWidth("↗")` cols + leading spaces), like the inline-link affordances. The vault absolute path is `vault` (the `formatTodayResult` arg). Render:

```ts
const arrow = caps.unicode ? "↗" : "->";
const originAff = t.origin === undefined
  ? ""
  : `   ${paint(`${hyperlink(arrow, originUrl(t.origin, vault), caps)}`, "ident", caps)}`;
// include originAff in the pushed line, and add its width to the reserve before shortenLabel
```

Update the width reserve so `label` + inline-link affordances + origin affordance ≤ `caps.width` (the Phase 1 width invariant — extend the reserve to include `originAff`'s visible width: `t.origin ? 3 + visibleWidth(arrow) : 0`). Import `originUrl` from `../presenter`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/cli/commands/today.test.ts tests/cli/presenter/`
Expected: PASS — URL → `↗` to the URL; vault path → `file://` `↗`; no origin → no arrow; no line exceeds `caps.width` (the existing width-bound tests still pass with the origin affordance reserved).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/today.ts src/cli/presenter/links.ts tests/cli/commands/today.test.ts
git commit -m "feat(cli): dome today renders task origin as one clickable ↗ (URL or file://)"
```

---

### Task 5: `slack-day` permalink grammar + parser field

**Files:**
- Modify: the Slack digest parser (`parseSlackDigest`; locate via `grep -rn "parseSlackDigest" assets/extensions/dome.agent/`)
- Modify: `docs/wiki/specs/vault-layout.md` (§"`sources/slack/YYYY-MM-DD.md`")
- Test: the parser's test file (locate via `grep -rln "parseSlackDigest" tests/`)

- [ ] **Step 1: Write the failing test**

Add to the parser test:

```ts
test("parses an optional trailing permalink autolink", () => {
  const d = parseSlackDigest('---\ntype: slack-day\ndate: 2026-06-15\n---\n\n## Mentions\n\n- [#dome-dev] 22:41 alice: "look?" <https://uniswap.slack.com/archives/C0/p1>\n');
  expect(d.mentions[0].permalink).toBe("https://uniswap.slack.com/archives/C0/p1");
});
test("an entry without a permalink has undefined permalink (back-compat)", () => {
  const d = parseSlackDigest('## Mentions\n\n- [#dome-dev] 22:41 alice: "look?"\n');
  expect(d.mentions[0].permalink).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test <parser test file> -t permalink`
Expected: FAIL — `permalink` field absent.

- [ ] **Step 3: Implement**

In the slack entry type add `readonly permalink?: string;`. In the per-entry parse, after extracting the entry text, pull a trailing autolink: `const pm = /\s*<(https?:\/\/[^>\s]+)>\s*$/.exec(rawText);` — if matched, set `permalink = pm[1]` and trim it off the entry text. Keep the existing per-entry text/length caps applied to the text WITHOUT the permalink.

- [ ] **Step 4: Update the grammar spec**

In `docs/wiki/specs/vault-layout.md` §"`sources/slack/YYYY-MM-DD.md`", add to the entry shape rules: "Each entry MAY carry a trailing permalink as an autolink `<https://…slack.com/…>`; consumers parse it into the entry's optional `permalink`. Absent = no link (back-compat)."

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test <parser test file> tests/integration` 2>&1 | tail -5`
Expected: PASS — permalink parsed; spec wikilinks resolve.

- [ ] **Step 6: Commit**

```bash
git add assets/extensions/dome.agent docs/wiki/specs/vault-layout.md tests
git commit -m "feat(dome.agent): slack-day entries carry an optional permalink; parser + spec"
```

---

### Task 6: `claude-slack.sh` emits permalinks

**Files:**
- Modify: `assets/source-handlers/claude-slack.sh`
- Test: none (shell template; covered by the parser back-compat tests + manual)

- [ ] **Step 1: Read the template and locate the prompt**

Run: `grep -n "Mentions\|permalink\|prompt\|FETCH\|digest" assets/source-handlers/claude-slack.sh`

- [ ] **Step 2: Add the permalink instruction**

In the prompt that produces each entry, add: "After each message's text, append the message's Slack permalink as an autolink in angle brackets, e.g. `… "text" <https://…slack.com/archives/…/p…>`. Use `chat.getPermalink` / the connector's message link. Omit the autolink only if no permalink is available." Keep the validated output shape (first line `---`, `date:`, `# Slack <date>`).

- [ ] **Step 3: Verify the template still validates structurally**

Run: `bash -n assets/source-handlers/claude-slack.sh`
Expected: no syntax errors (the FETCH itself is not executed here).

- [ ] **Step 4: Commit**

```bash
git add assets/source-handlers/claude-slack.sh
git commit -m "feat(sources): claude-slack.sh emits per-message permalinks (foreground reference)"
```

---

### Task 7: Ingest stamps a URL origin for URL-bearing captures

**Files:**
- Modify: `assets/extensions/dome.agent/processors/ingest.ts` (set `capturedTasks.origin` to a capture's source URL when present)
- Modify: `assets/extensions/dome.agent/lib/ingest-tools.ts` if needed (origin already an arbitrary string — likely no change)
- Test: `tests/extensions/dome.agent/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("a capture with a source_url stamps the slack permalink as the task origin", async () => {
  const raw = "inbox/raw/2026-06-08-jane.md";
  const expectedDate = formatDate(localDateParts(new Date("2026-06-08T12:00:00Z")));
  const dailyP = `wiki/dailies/${expectedDate}.md`;
  const ctx = makeCtx({
    files: { [raw]: "---\nsource_url: https://uniswapteam.slack.com/archives/C0/p1\n---\n\nreply to Jane" },
    changedPaths: [raw],
    steps: [
      { toolCalls: [
        { id: "1", name: "appendToPage", input: { path: dailyP, content: "- [ ] #task reply to Jane" } },
        { id: "2", name: "archiveSource", input: { rawPath: raw } },
      ] },
      { text: "ingested" },
    ],
  });
  const effects = await ingest.run(ctx);
  const patch = effects.find((e) => e.kind === "patch") as PatchEffect;
  const daily = patch.changes.find((c) => String(c.path) === dailyP)!;
  expect(String(daily.content)).toContain("([↗](https://uniswapteam.slack.com/archives/C0/p1))");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts -t source_url`
Expected: FAIL — origin is the archived path, not the URL.

- [ ] **Step 3: Implement**

In `ingest.ts`, where `capturedTasks.origin = archivedCapturePath(sourcePath)` is set per source, override with a capture URL when present:

```ts
const sourceUrl = extractCaptureSourceUrl(source); // see helper below
capturedTasks.origin = sourceUrl ?? archivedCapturePath(sourcePath);
```

Add a small helper (in `ingest.ts` or a lib file):

```ts
// A capture's external source URL: `source_url:` frontmatter (primary), else the
// first bare Slack URL in the body (fallback). Only https accepted.
function extractCaptureSourceUrl(source: string): string | null {
  const fm = /^---\n([\s\S]*?)\n---/.exec(source);
  if (fm) {
    const m = /^source_url:\s*(\S+)\s*$/m.exec(fm[1]!);
    if (m && /^https:\/\//.test(m[1]!)) return m[1]!;
  }
  const slack = /\bhttps:\/\/[a-z0-9.-]*slack\.com\/\S+/i.exec(source);
  return slack ? slack[0] : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/extensions/dome.agent/ingest.test.ts`
Expected: PASS — `source_url` capture stamps the URL; the plain-capture backlink test (archived path) still passes.

- [ ] **Step 5: Commit**

```bash
git add assets/extensions/dome.agent/processors/ingest.ts tests/extensions/dome.agent/ingest.test.ts
git commit -m "feat(dome.agent): ingest stamps a capture's source_url as the task origin"
```

---

### Task 8: Full suite + spec sweep

- [ ] **Step 1: Update the task-lifecycle spec for the unified origin axis**

In `docs/wiki/specs/task-lifecycle.md`, add a short normative paragraph (near the origin-marker mention): the origin marker `([↗](target))` is the single source-provenance grammar (target = vault path or percent-encoded URL), defined once in `action-extraction`, stripped from identity/dedup/reconcile keys, carried as a structured `origin` on the task projection, and rendered as one `↗` affordance in `dome today` (URL or `file://`). Distinct from the `(from [[…]])` copy-provenance suffix. Design: `[[cohesive/brainstorms/2026-06-15-daily-phase2]]`.

- [ ] **Step 2: Run the full suite**

Run: `bun test`
Expected: PASS. Watch `tests/extensions/daily-*`, `tests/cli/commands/today.test.ts`, `tests/surface/today-view.test.ts`, `tests/http/today-html.test.ts` (the HTML cockpit shares the today-view parser — confirm `origin` is optional there and it stays green), and `tests/integration` (wikilink/spec lockstep).

- [ ] **Step 3: Commit the spec**

```bash
git add docs/wiki/specs/task-lifecycle.md
git commit -m "docs(task-lifecycle): document the unified origin axis (Phase 2 P1)"
```

- [ ] **Step 4: Do NOT merge yet** — Plans 2 and 3 build on this branch. The controller writes Plan 2 next.

---

## Self-review notes
- **Spec coverage (P1):** marker unify (T1), `)`-safe (T1), origin field (T2/T3), one render rule incl. `file://` (T4), slack-day permalinks (T5/T6), ingest URL stamping (T7), spec (T8). ✓
- **Identity safety:** stableId/dedup/reconcile keep consuming the stripped `body`; the marker rides only the fact `object.value` (parsed back at the view) and the markdown line. ✓
- **Width invariant:** T4 reserves the origin affordance width (Phase 1 contract). ✓
- **Back-compat:** vault paths have no `()` so encoding is a no-op for existing capture markers; slack permalink is optional. ✓
