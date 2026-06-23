# View Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the L2 `today` three-tier surface view-model into an L3 **View Contract** seam: every first-party catalog view declares one zod payload schema (tier 1, killing `data: unknown`) and an optional view-model builder (tier 2), bound in `FirstPartyViewEntry`; adapters only paint (tier 3). Delete the three hand-rolled `parse(unknown)` coercers (`parseTodayView`, `parseQueryResult`, `parseLintData`).

**Architecture:** This is the `row-codec` move one layer up — replace N hand-rolled `parse(unknown) → domain` coercers with one declared contract per view, the way `rowCodec.define` replaced N hand-rolled `rowToXxx` mappers. The catalog entry grows from a bag of strings into a typed contract `FirstPartyViewEntry<TPayload, TView>` carrying a surface-side zod `payload` schema and an optional `buildViewModel`. `runCatalogView`/`validateStructuredRun` go generic over `TPayload` and drive the parse from `entry.payload`. Strict `parse` is tier-1; degrade-don't-fail is a *paint-tier* choice (`safeParse`) reserved for `today`. Producers in bundles keep importing only the erased `z.infer` type — no runtime zod crosses into a bundle.

**Tech Stack:** TypeScript, Bun, zod (already a dep), the four-concept Dome engine.

## Global Constraints

- **Canonical gate:** `bun test ./tests` (NOT bare `bun test`). Full-repo `tsc` is pre-existing red (`tests/sqlite/open-store.test.ts`); verify touched files are clean via `bunx tsc --noEmit 2>&1 | grep <file>` (expect no lines for a touched file). Run scoped test files, not the whole suite under parallel load.
- **Producer keeps zero runtime zod dependency.** Producers import `type` only (`z.infer<typeof schema>`, erased). The schema lives surface-side. Verify the bundle-deps fence (`tests/integration/bundle-deps.test.ts`) stays green after each migration.
- **Schemas are the single source of truth.** Each view's payload type becomes `type X = z.infer<typeof xPayloadSchema>` — do not keep a parallel hand-written type. Encode existing leniency (defaults, fallbacks, drop-malformed) into the schema with `.default()` / `.catch()` so behavior is preserved.
- **One behavior change is allowed and intended:** `query`/`lint`/`export-context` now **hard-fail** on a malformed payload (a `invalid-payload` problem) instead of silently degrading. `today` keeps degrade-don't-fail. Every other adapter test stays green verbatim; a golden-test edit outside these views means STOP.
- **Naming:** the catalog entry's string version tag is renamed `schema` → `schemaTag` (it is a tag, not a schema; `payload` is the schema). This is a mechanical rename `tsc` will pin.

---

## File Structure

- `src/surface/view-catalog.ts` — `FirstPartyViewEntry<TPayload, TView>` becomes generic; each entry gains `payload` (zod) + optional `buildViewModel`. Imports per-view schemas from the surface modules below.
- `src/surface/adapter.ts` — `runCatalogView` / `validateStructuredRun` generic over `TPayload`; new `invalid-payload` problem; parse driven by `entry.payload`.
- `src/surface/view.ts` — `StructuredViewCommandResult.data` and `runStructuredViewCommand` generic over `TPayload`.
- `src/surface/lint-view.ts` — **new.** `lintPayloadSchema`, `type LintData = z.infer<…>`, `renderLintText` (moved from `cli/commands/lint.ts`). No view-model (render reads payload directly).
- `src/surface/query-view.ts` — **new.** `queryPayloadSchema`, `type QueryResultData = z.infer<…>`, `formatQueryResult` (moved from `cli/commands/query.ts`).
- `src/surface/today-view.ts` — `todayPayloadSchema` referenced by the catalog entry; `buildTodayViewModel` becomes the entry's `buildViewModel`. `parseTodayView` deleted; its lenient defaults move into the schema via `.catch()`/`.default()`.
- `src/cli/commands/{lint,query,export-context,today}.ts` — `renderHuman` now receives typed payload; delete the local `parseXxx`.
- `src/cli/structured-view-command.ts` — `renderHuman`/`successExitCode` typed `(payload: TPayload)`.
- `src/mcp/server.ts`, `src/http/server.ts` — consume typed `data`; `today` MCP/HTTP keep `safeParse`-via-entry degrade.
- `docs/glossary.md`, `docs/wiki/concepts/surface-view-model.md` — add the **View Contract** term + L3 generalization.

---

## Task 1: The generic View Contract seam

**Files:**
- Modify: `src/surface/view-catalog.ts`
- Modify: `src/surface/adapter.ts:108-214` (problem union, `runCatalogView`, `validateStructuredRun`)
- Modify: `src/surface/view.ts:74-230` (generic `runStructuredViewCommand`)
- Test: `tests/surface/view-contract.test.ts` (new)

**Interfaces:**
- Produces: `FirstPartyViewEntry<TPayload = unknown, TView = TPayload>` with fields `command, viewName, schemaTag, bundleId, processorName, payload: ZodType<TPayload>, buildViewModel?: (p: TPayload) => TView`.
- Produces: `runCatalogView<TPayload>(vault, entry): Promise<CatalogViewOutcome<TPayload>>` where the ok branch is `{ kind:"ok"; data: TPayload; brokerDiagnostics }`.
- Produces: `CatalogViewProblem` gains `{ kind: "invalid-payload"; issues: string }`.
- Produces: `validateStructuredRun<TPayload>(run, expected: { viewName; schemaTag; payload: ZodType<TPayload> }) → { kind:"ok"; data: TPayload } | { kind:"problem"; problem }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/surface/view-contract.test.ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateStructuredRun } from "../../src/surface/adapter";

const payload = z.object({ n: z.number() });
const expected = { viewName: "v.test", schemaTag: "v.test/v1", payload };

describe("validateStructuredRun (generic payload)", () => {
  test("parses a valid payload to the typed value", () => {
    const r = validateStructuredRun(
      { views: [{ name: "v.test" }], structured: { schema: "v.test/v1", data: { n: 7 } } },
      expected,
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.data.n).toBe(7);
  });

  test("a payload that fails the schema is an invalid-payload problem", () => {
    const r = validateStructuredRun(
      { views: [{ name: "v.test" }], structured: { schema: "v.test/v1", data: { n: "nope" } } },
      expected,
    );
    expect(r.kind).toBe("problem");
    if (r.kind === "problem") expect(r.problem.kind).toBe("invalid-payload");
  });

  test("schemaTag mismatch is still wrong-schema, not invalid-payload", () => {
    const r = validateStructuredRun(
      { views: [{ name: "v.test" }], structured: { schema: "v.test/v2", data: { n: 1 } } },
      expected,
    );
    expect(r.kind).toBe("problem");
    if (r.kind === "problem") expect(r.problem.kind).toBe("wrong-schema");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/surface/view-contract.test.ts`
Expected: FAIL — `validateStructuredRun` does not accept `payload`, returns `data: unknown`.

- [ ] **Step 3: Implement — generic entry type**

In `src/surface/view-catalog.ts`, replace the `FirstPartyViewEntry` type and re-tag the entries (schemas wired in later tasks; until then use `z.unknown()` placeholders so this task compiles standalone):

```ts
import type { ZodType } from "zod";
import { z } from "zod";

export type FirstPartyViewEntry<TPayload = unknown, TView = TPayload> = {
  readonly command: string;
  readonly viewName: string;
  /** The expected structured-content version tag (`<viewName>/v1`). */
  readonly schemaTag: string;
  readonly bundleId: string;
  readonly processorName: string;
  /** Tier-1 contract: validates the structured payload. */
  readonly payload: ZodType<TPayload>;
  /** Tier-2: derive render semantics. Absent for passthrough views. */
  readonly buildViewModel?: (payload: TPayload) => TView;
};
```

Update each entry: rename `schema:` → `schemaTag:` and add `payload: z.unknown(),` (replaced by real schemas in Tasks 2-5).

- [ ] **Step 4: Implement — generic validate + invalid-payload**

In `src/surface/adapter.ts`, add to `CatalogViewProblem`:

```ts
  | { readonly kind: "invalid-payload"; readonly issues: string };
```

Make `CatalogViewOutcome` generic and rewrite `validateStructuredRun` to parse via `expected.payload` (and accept `schemaTag`):

```ts
export type CatalogViewOutcome<TPayload = unknown> =
  | { readonly kind: "ok"; readonly data: TPayload; readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect> }
  | { readonly kind: "problem"; readonly problem: CatalogViewProblem };

export function validateStructuredRun<TPayload>(
  run: {
    readonly views: ReadonlyArray<{ readonly name: string }>;
    readonly structured: { readonly schema: string; readonly data: unknown } | null;
  },
  expected: { readonly viewName: string; readonly schemaTag: string; readonly payload: ZodType<TPayload> },
): { readonly kind: "ok"; readonly data: TPayload } | { readonly kind: "problem"; readonly problem: CatalogViewProblem } {
  if (run.views.length === 0) return { kind: "problem", problem: { kind: "no-structured-result" } };
  if (run.views.length !== 1) return { kind: "problem", problem: { kind: "multiple-views", count: run.views.length } };
  const view = run.views[0];
  if (view !== undefined && view.name !== expected.viewName) {
    return { kind: "problem", problem: { kind: "wrong-view", got: view.name } };
  }
  if (run.structured === null) return { kind: "problem", problem: { kind: "no-structured-result" } };
  if (run.structured.schema !== expected.schemaTag) {
    return { kind: "problem", problem: { kind: "wrong-schema", got: run.structured.schema } };
  }
  const parsed = expected.payload.safeParse(run.structured.data);
  if (!parsed.success) {
    return { kind: "problem", problem: { kind: "invalid-payload", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ") } };
  }
  return { kind: "ok", data: parsed.data };
}
```

Update `runCatalogView` to `runCatalogView<TPayload>(vault, entry: FirstPartyViewEntry<TPayload>, args?): Promise<CatalogViewOutcome<TPayload>>` and pass `{ viewName: entry.viewName, schemaTag: entry.schemaTag, payload: entry.payload }` to `validateStructuredRun`. Add the `invalid-payload` arm to `catalogViewProblemMessage`:

```ts
    case "invalid-payload":
      return `${commandLabel}: ${entry.processorName} processor returned a payload that failed validation (${problem.issues}).`;
```

Add `invalid-payload` to `catalogViewProblemExitCode` default (1) — already covered by the `default:` arm.

- [ ] **Step 5: Implement — generic view.ts runner**

In `src/surface/view.ts`, make `StructuredViewCommandResult` generic (`data: TPayload`) and `runStructuredViewCommand<TPayload>(opts: { …; entry: FirstPartyViewEntry<TPayload> }): Promise<StructuredViewCommandResult<TPayload>>`. Pass `{ viewName: entry.viewName, schemaTag: entry.viewName + …}` — use `entry.schemaTag` and `entry.payload` to `validateStructuredRun`. Replace the `entry.schema` reference at the validate call with `entry.schemaTag` and add `payload: entry.schemaTag`-> `payload: entry.payload`.

- [ ] **Step 6: Run tests to verify pass**

Run: `cd <worktree> && bun test tests/surface/view-contract.test.ts tests/surface/`
Expected: PASS (new test green; existing surface tests green — `z.unknown()` placeholders accept any data, preserving today's behavior).

- [ ] **Step 7: Verify touched files typecheck**

Run: `cd <worktree> && bunx tsc --noEmit 2>&1 | grep -E "surface/(adapter|view|view-catalog)" ; echo "exit: $?"`
Expected: no lines (grep exit 1 = no matches).

- [ ] **Step 8: Commit**

```bash
git add src/surface/view-catalog.ts src/surface/adapter.ts src/surface/view.ts tests/surface/view-contract.test.ts
git commit -m "feat(surface): generic View Contract seam — entry carries payload schema; invalid-payload problem"
```

---

## Task 2: Migrate `lint` to the View Contract

**Files:**
- Create: `src/surface/lint-view.ts`
- Modify: `src/surface/view-catalog.ts` (lint entry `payload`)
- Modify: `src/cli/commands/lint.ts` (delete `parseLintData`/`LintData`/`renderLintText`; import from surface)
- Test: `tests/surface/lint-view.test.ts` (new)

**Interfaces:**
- Consumes: `FirstPartyViewEntry<TPayload>` (Task 1).
- Produces: `lintPayloadSchema`, `type LintData = z.infer<typeof lintPayloadSchema>`, `renderLintText(data: LintData, vaultPath, verbose?)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/surface/lint-view.test.ts
import { describe, expect, test } from "bun:test";
import { lintPayloadSchema } from "../../src/surface/lint-view";

describe("lintPayloadSchema", () => {
  test("parses a full lint payload", () => {
    const r = lintPayloadSchema.parse({
      status: "fail", failOn: "error",
      checked: { markdownFiles: 12 },
      counts: { total: 3, info: 1, warning: 1, error: 1, block: 0 },
      shownIssues: 3, omittedIssues: 0,
      issues: [{ severity: "error", code: "X", message: "m", sourceRefs: [{ path: "a.md", commit: "abc" }] }],
    });
    expect(r.status).toBe("fail");
    expect(r.issues[0]?.sourceRefs[0]?.path).toBe("a.md");
  });

  test("backfills lenient defaults (missing counts → 0, missing failOn → error)", () => {
    const r = lintPayloadSchema.parse({ status: "pass", checked: {}, counts: {}, issues: [] });
    expect(r.failOn).toBe("error");
    expect(r.counts.total).toBe(0);
    expect(r.checked.markdownFiles).toBe(0);
  });

  test("rejects a bad status (hard contract)", () => {
    expect(() => lintPayloadSchema.parse({ status: "weird" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <worktree> && bun test tests/surface/lint-view.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/surface/lint-view.ts`**

Encode the leniency that `parseLintData` had (defaults) into the schema. Move `renderLintText` here verbatim from `cli/commands/lint.ts` (and its helper imports).

```ts
import { z } from "zod";

const lintSeveritySchema = z.enum(["info", "warning", "error", "block"]);

export const lintPayloadSchema = z.object({
  status: z.enum(["pass", "fail"]),
  failOn: z.string().catch("error").default("error"),
  checked: z.object({ markdownFiles: z.number().catch(0).default(0) }).catch({ markdownFiles: 0 }).default({ markdownFiles: 0 }),
  counts: z.object({
    total: z.number().catch(0).default(0),
    info: z.number().catch(0).default(0),
    warning: z.number().catch(0).default(0),
    error: z.number().catch(0).default(0),
    block: z.number().catch(0).default(0),
  }).catch({ total: 0, info: 0, warning: 0, error: 0, block: 0 }),
  shownIssues: z.number().optional(),
  omittedIssues: z.number().catch(0).default(0),
  issues: z.array(z.object({
    severity: lintSeveritySchema.catch("info").default("info"),
    code: z.string().catch("").default(""),
    message: z.string().catch("").default(""),
    sourceRefs: z.array(z.object({
      path: z.string().catch("").default(""),
      commit: z.string().catch("").default(""),
    })).catch([]).default([]),
  })).catch([]).default([]),
}).transform((d) => ({ ...d, shownIssues: d.shownIssues ?? d.issues.length }));

export type LintSeverity = z.infer<typeof lintSeveritySchema>;
export type LintData = z.infer<typeof lintPayloadSchema>;

// renderLintText(data: LintData, vaultPath: string, verbose = false): string
// (moved verbatim from cli/commands/lint.ts — keep its formatting helpers)
```

(Move the full `renderLintText` body + its `headline/section/kv/dimZeros/...` imports from `cli/commands/lint.ts` into this module.)

- [ ] **Step 4: Wire the catalog entry + CLI**

In `view-catalog.ts`, set the lint entry's `payload: lintPayloadSchema` (import from `./lint-view`). In `cli/commands/lint.ts`: delete `parseLintData`, the local `LintData`/`LintIssueData`/`LintSeverity` types, and `renderLintText`; import `renderLintText` + `LintData` from `../../surface/lint-view`. The `renderHuman`/`successExitCode` now receive typed `LintData`:

```ts
    renderHuman: (data) => renderLintText(data, resolveVaultPath(options.vault), options.verbose === true),
    successExitCode: (data) => (data.status === "fail" ? 1 : 0),
```

- [ ] **Step 5: Run tests**

Run: `cd <worktree> && bun test tests/surface/lint-view.test.ts tests/cli/commands/lint.test.ts`
Expected: PASS. The lint golden tests stay green (defaults preserve behavior); a malformed payload now hard-fails — if a lint test fed a deliberately-partial payload and expected a degraded render, update it with a comment citing this plan.

- [ ] **Step 6: Verify typecheck + bundle fence**

Run: `cd <worktree> && bunx tsc --noEmit 2>&1 | grep -E "lint" ; bun test tests/integration/bundle-deps.test.ts`
Expected: no lint type errors; bundle-deps green.

- [ ] **Step 7: Commit**

```bash
git add src/surface/lint-view.ts src/surface/view-catalog.ts src/cli/commands/lint.ts tests/surface/lint-view.test.ts
git commit -m "feat(surface): lint View Contract — lintPayloadSchema; delete parseLintData"
```

---

## Task 3: Migrate `query` to the View Contract

**Files:**
- Create: `src/surface/query-view.ts`
- Modify: `src/surface/view-catalog.ts` (query entry `payload`)
- Modify: `src/cli/commands/query.ts` (delete `parseQueryResult`/`QueryResultData`; import from surface)
- Test: `tests/surface/query-view.test.ts` (new)

**Interfaces:**
- Produces: `queryPayloadSchema`, `type QueryResultData = z.infer<typeof queryPayloadSchema>`, `formatQueryResult(data: QueryResultData, caps, vault?)`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/surface/query-view.test.ts
import { describe, expect, test } from "bun:test";
import { queryPayloadSchema } from "../../src/surface/query-view";

describe("queryPayloadSchema", () => {
  test("parses a query payload with a match", () => {
    const r = queryPayloadSchema.parse({
      query: "x", limit: 10, shown: { matches: 1 }, hasMore: { matches: false },
      matches: [{ path: "a.md", title: "A", snippet: "s", sourceRefs: [], facts: [], diagnostics: [], questions: [] }],
    });
    expect(r.query).toBe("x");
    expect(r.matches[0]?.path).toBe("a.md");
    expect(r.matches[0]?.breadcrumb).toBeNull();
    expect(r.matches[0]?.ranking).toBeNull();
  });

  test("shown.matches backfills from matches length when absent", () => {
    const r = queryPayloadSchema.parse({ query: "x", shown: {}, hasMore: {}, matches: [{ path: "a.md", title: "", snippet: "" }] });
    expect(r.shown.matches).toBe(1);
  });

  test("rejects a non-string query (hard contract)", () => {
    expect(() => queryPayloadSchema.parse({ query: 5, shown: {}, hasMore: {}, matches: [] })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd <worktree> && bun test tests/surface/query-view.test.ts` → FAIL (no module).

- [ ] **Step 3: Implement `src/surface/query-view.ts`**

Mirror `parseQueryResult` (`cli/commands/query.ts:217`) field-for-field as a schema; `query` is required (hard), the rest lenient. `shown.matches` backfill needs a superRefine/transform against `matches.length`. Move `formatQueryResult` + helpers here.

```ts
import { z } from "zod";

const sourceRefSchema = z.object({
  path: z.string().catch(""),
  commit: z.string().catch(""),
  range: z.object({ startLine: z.number(), endLine: z.number() }).optional(),
});
const rankingSignalSchema = z.object({
  kind: z.string(), label: z.string(), weight: z.number(), count: z.number().optional(),
});
const rankingSchema = z.object({
  score: z.number().catch(0).default(0),
  ftsRank: z.number().catch(0).default(0),
  reasons: z.array(z.string()).catch([]).default([]),
  signals: z.array(rankingSignalSchema).catch([]).default([]),
}).nullable().catch(null);
const matchSchema = z.object({
  path: z.string().catch(""),
  title: z.string().catch(""),
  breadcrumb: z.string().min(1).nullable().catch(null).default(null),
  snippet: z.string().catch(""),
  ranking: rankingSchema.default(null),
  sourceRefs: z.array(sourceRefSchema).catch([]).default([]),
  facts: z.array(z.unknown()).catch([]).default([]),       // mirror parseFacts shape
  diagnostics: z.array(z.unknown()).catch([]).default([]), // mirror parseDiagnostics shape
  questions: z.array(z.unknown()).catch([]).default([]),   // mirror parseQuestions shape
});
export const queryPayloadSchema = z.object({
  query: z.string(),                       // required — hard contract
  limit: z.number().nullable().catch(null).default(null),
  shown: z.object({ matches: z.number().optional() }).catch({}),
  hasMore: z.object({ matches: z.boolean().catch(false).default(false) }).catch({ matches: false }),
  matches: z.array(matchSchema).catch([]),
}).transform((d) => ({ ...d, shown: { matches: d.shown.matches ?? d.matches.length } }));

export type QueryResultData = z.infer<typeof queryPayloadSchema>;
// formatQueryResult(data: QueryResultData, caps, vault?): string — moved from cli/commands/query.ts
```

**Note (no silent cap):** the `facts`/`diagnostics`/`questions` arrays currently parse to richer shapes via `parseFacts`/`parseDiagnostics`/`parseQuestions`. Port those exact element schemas (read `query.ts:300+`) rather than `z.unknown()` — `z.unknown()` here is a placeholder the implementer MUST replace so the rendered output is byte-identical. Verify against `tests/cli/commands/query.test.ts` golden output.

- [ ] **Step 4: Wire catalog + CLI** — query entry `payload: queryPayloadSchema`; delete `parseQueryResult`/`QueryResultData` from `query.ts`; import `formatQueryResult` from `../../surface/query-view`; `renderHuman: (data) => formatQueryResult(data, resolveCaps(), vaultPath)`.

- [ ] **Step 5: Run tests** — `cd <worktree> && bun test tests/surface/query-view.test.ts tests/cli/commands/query.test.ts` → PASS.

- [ ] **Step 6: Typecheck** — `cd <worktree> && bunx tsc --noEmit 2>&1 | grep -E "query" ; echo done` → no query errors.

- [ ] **Step 7: Commit**

```bash
git add src/surface/query-view.ts src/surface/view-catalog.ts src/cli/commands/query.ts tests/surface/query-view.test.ts
git commit -m "feat(surface): query View Contract — queryPayloadSchema; delete parseQueryResult"
```

---

## Task 4: Migrate `today` — schema into the entry, view-model as `buildViewModel`, degrade at paint

**Files:**
- Modify: `src/surface/today-view.ts` (encode `parseTodayView` leniency into `todayPayloadSchema`; delete `parseTodayView`)
- Modify: `src/surface/view-catalog.ts` (today entry `payload: todayPayloadSchema`, `buildViewModel: buildTodayViewModel`)
- Modify: `src/cli/commands/today.ts`, `src/http/today-html.ts`, `src/mcp/server.ts` (paint from entry; `safeParse` degrade)
- Test: `tests/surface/today-view.test.ts` (extend)

**Interfaces:**
- Consumes: `FirstPartyViewEntry<TodayPayload, TodayViewModel>`.
- Produces: `today` entry with `payload` + `buildViewModel`; `parseTodayView` removed.

- [ ] **Step 1: Write the failing test** — assert the today entry exposes a working `buildViewModel`, and that the schema applies today's lenient defaults (missing `date` → `"today"`, malformed row dropped, counts backfilled):

```ts
// tests/surface/today-view.test.ts (add)
import { FIRST_PARTY_VIEWS } from "../../src/surface/view-catalog";
test("today entry builds a view-model from a parsed payload", () => {
  const entry = FIRST_PARTY_VIEWS.today;
  const payload = entry.payload.parse({ date: "2026-06-23", counts: {}, openTasks: [], followups: [], questions: [], brief: null, calendar: null, hero: null });
  const vm = entry.buildViewModel!(payload);
  expect(vm.totalOpen).toBe(0);
});
test("today schema defaults missing date to 'today' (degrade preserved)", () => {
  const r = FIRST_PARTY_VIEWS.today.payload.parse({});
  expect(r.date).toBe("today");
});
```

- [ ] **Step 2: Run to verify fail** — degrade defaults + `buildViewModel` on the entry don't exist yet → FAIL.

- [ ] **Step 3: Fold leniency into `todayPayloadSchema`**

Add the `parseTodayView` defaults to the schema (`date: z.string().catch("today").default("today")`, counts `.catch()` backfill, task/question rows `.catch()`-drop-malformed via `z.array(...).catch([])` and per-row optional fields). The wikilink-strip / entity-derivation enrichment moves into `buildTodayViewModel` (tier 2) — it is *not* validation. Delete `parseTodayView`.

- [ ] **Step 4: Wire the entry + paint sites**

`view-catalog.ts`: today entry `payload: todayPayloadSchema, buildViewModel: buildTodayViewModel`. In `today.ts` CLI, `today-html.ts` HTTP, and `mcp/server.ts`: obtain the payload via `entry.payload.safeParse(data)` (degrade: on failure, fall back to `entry.payload.parse({})` defaults → still renders) and call `entry.buildViewModel(payload)`; delete direct `parseTodayView`/`todayPayloadSchema` imports where the entry now provides them.

- [ ] **Step 5: Run tests** — `cd <worktree> && bun test tests/surface/today-view.test.ts tests/cli/commands/today.test.ts tests/http/today-html.test.ts` → PASS (today render byte-identical; degrade preserved).

- [ ] **Step 6: Typecheck** — `cd <worktree> && bunx tsc --noEmit 2>&1 | grep -E "today" ; echo done`.

- [ ] **Step 7: Commit**

```bash
git add src/surface/today-view.ts src/surface/view-catalog.ts src/cli/commands/today.ts src/http/today-html.ts src/mcp/server.ts tests/surface/today-view.test.ts
git commit -m "feat(surface): today View Contract — schema+view-model on the entry; delete parseTodayView"
```

---

## Task 5: Migrate `export-context` (tier-1 only — the passthrough exception)

**Files:**
- Modify: `src/surface/view-catalog.ts` (exportContext entry `payload`)
- Modify: `src/cli/commands/export-context.ts` (delete `markdownFromData`; render from typed payload)
- Test: `tests/surface/view-catalog.test.ts` (extend) or a small `tests/cli/commands/export-context.test.ts`

**Interfaces:**
- Produces: `exportContextPayloadSchema = z.object({ markdown: z.string(), sourceRefs: z.array(...).optional() })` in `view-catalog.ts` (small enough to inline; no separate module, no view-model).

- [ ] **Step 1: Write the failing test**

```ts
test("export-context entry rejects a payload missing markdown", () => {
  expect(() => FIRST_PARTY_VIEWS.exportContext.payload.parse({})).toThrow();
});
test("export-context entry accepts a markdown payload", () => {
  const r = FIRST_PARTY_VIEWS.exportContext.payload.parse({ markdown: "# hi" });
  expect(r.markdown).toBe("# hi");
});
```

- [ ] **Step 2: Run to verify fail** — `z.unknown()` placeholder still accepts `{}` → FAIL.

- [ ] **Step 3: Implement** — set exportContext entry `payload: z.object({ markdown: z.string() }).passthrough()`. In `export-context.ts` delete `markdownFromData`; `renderHuman: (data) => data.markdown`.

- [ ] **Step 4: Run tests** — `cd <worktree> && bun test tests/surface/ tests/cli/commands/export-context.test.ts 2>/dev/null; bun test tests/surface/view-catalog.test.ts` → PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
git add src/surface/view-catalog.ts src/cli/commands/export-context.ts tests/surface/view-catalog.test.ts
git commit -m "feat(surface): export-context View Contract — tier-1 markdown payload; delete markdownFromData"
```

---

## Task 6: Domain model — name the View Contract

**Files:**
- Modify: `docs/glossary.md`
- Modify/Create: `docs/wiki/concepts/surface-view-model.md`

- [ ] **Step 1: Add the glossary term** — under "Product surfaces" in `docs/glossary.md`:

```markdown
- **View Contract** — a first-party view's single declaration (`FirstPartyViewEntry`): command trigger, expected ViewEffect name + version tag, and the zod **payload** schema (tier 1) plus optional **view-model** builder (tier 2) every adapter validates against and paints from. The view-layer analog of the sqlite [[row-codec]]. [[wiki/specs/sdk-surface]]
```

- [ ] **Step 2: Fold the L3 generalization into the concept doc** — update `docs/wiki/concepts/surface-view-model.md` to record that the seam is now generic across all four catalog views (`today`, `query`, `lint`, `export-context`), strict-parse tier-1, degrade-at-paint for `today` only, and that `status`/`check` stay out (typed collectors). Note the design-it-twice trigger was met by `query`/`lint`, not `status`.

- [ ] **Step 3: Commit**

```bash
git add docs/glossary.md docs/wiki/concepts/surface-view-model.md
git commit -m "docs: name the View Contract; record L3 generalization across catalog views"
```

---

## Self-Review

- **Spec coverage:** Scope (4 catalog views, status/check out) → Tasks 2-5 + constraints. Seam shape (entry as typed contract, generic runner) → Task 1. Validation posture (strict tier-1, enrich→tier-2) → Tasks 2-4. Erasure (surface-side schema, erased producer type) → Global Constraints + per-task bundle-deps check. Tag+zod (both kept) → Task 1 (`schemaTag` + `payload`, `wrong-schema` vs `invalid-payload`). Uniform tiering w/ export-context exception → Tasks 2-5. Degrade per-view (today degrades, rest hard-fail) → Task 4 (safeParse) vs Tasks 2/3/5 (parse). Migration order today→lint→query→export-context: **adjusted** — Task 1 seam first (with `z.unknown()` placeholders so each migration is independent), then lint (cleanest typed shape) → query → today (most load-bearing, last) → export-context. Glossary → Task 6.
- **Placeholder scan:** the only deliberate placeholders are the `z.unknown()` catalog defaults in Task 1 (each replaced by its real schema in Tasks 2-5) and the `facts/diagnostics/questions` element schemas in Task 3 (Step 3 flags them as MUST-replace with a verification against the query golden test). No "TBD"/"handle edge cases".
- **Type consistency:** `schemaTag` used consistently (Task 1 rename); `FirstPartyViewEntry<TPayload, TView>`, `CatalogViewOutcome<TPayload>`, `validateStructuredRun<TPayload>` align; each view's `type X = z.infer<typeof xPayloadSchema>` replaces the prior hand-written type of the same name (`LintData`, `QueryResultData`, `TodayPayload`).
