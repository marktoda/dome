// surface/view-catalog: the first-party views every surface exposes.
//
// One declaration per surfaced view — command-trigger name, expected
// ViewEffect name, expected structured schema, owning bundle — consumed by
// the CLI verbs (`dome query`, `dome export-context`, `dome lint`), the MCP
// tools, and the HTTP routes. Before this catalog, the same constants were
// re-declared in three adapters; a processor rename had to be chased through
// all of them. The lockstep test (tests/surface/view-catalog.test.ts) pins
// every entry to a shipped view-phase command trigger.

import { z, type ZodType } from "zod";

import { lintPayloadSchema } from "./lint-view";
import { queryPayloadSchema } from "./query-view";
import { taskBacklogListSchema } from "./task-backlog";
import { todayPayloadSchema } from "./today-view";

/**
 * `dome.search.export-context/v1` — a mostly-pass-through View Contract. The
 * CLI paint reads only `markdown`, but the JSON surface is a stable envelope,
 * so declare the top-level keys in producer order and still pass through any
 * future fields.
 */
const exportContextPayloadSchema = z
  .object({
    schema: z
      .literal("dome.search.export-context/v1")
      .catch("dome.search.export-context/v1"),
    topic: z.string().catch(""),
    limit: z.number().nullable().catch(null),
    shown: z.object({ entries: z.number().catch(0) }).catch({ entries: 0 }),
    hasMore: z
      .object({ entries: z.boolean().catch(false) })
      .catch({ entries: false }),
    overview: z.unknown().catch({}),
    markdown: z.string(),
    entries: z.array(z.unknown()).catch([]),
  })
  .passthrough();

/**
 * A first-party view's **View Contract** — the single declaration every
 * adapter validates against and paints from. Tier 1 is the `payload` schema
 * (kills `data: unknown`); tier 2 is the optional `buildViewModel` (derived
 * render semantics); tier 3 is the adapter's paint. The view-layer analog of
 * the sqlite row-codec. `TView` defaults to `TPayload` for passthrough views
 * that carry no view-model.
 */
export type FirstPartyViewEntry<TPayload = unknown, TView = TPayload> = {
  /** The command-trigger name (`vault.runView(command, …)`). */
  readonly command: string;
  /** The expected ViewEffect name the processor emits. */
  readonly viewName: string;
  /** The expected structured-content version tag (`<viewName>/v1`). */
  readonly schemaTag: string;
  /** The owning bundle (not-found messaging + lockstep). */
  readonly bundleId: string;
  /** Short processor label for operator messages. */
  readonly processorName: string;
  /** Tier 1: validates the structured payload to `TPayload`. */
  readonly payload: ZodType<TPayload>;
  /** Tier 2: derive render semantics. Absent for passthrough views. */
  readonly buildViewModel?: (payload: TPayload) => TView;
};

export const FIRST_PARTY_VIEWS = {
  query: Object.freeze({
    command: "query",
    viewName: "dome.search.query",
    schemaTag: "dome.search.query/v1",
    bundleId: "dome.search",
    processorName: "query",
    payload: queryPayloadSchema,
  }),
  exportContext: Object.freeze({
    command: "export-context",
    viewName: "dome.search.export-context",
    schemaTag: "dome.search.export-context/v1",
    bundleId: "dome.search",
    processorName: "export-context",
    payload: exportContextPayloadSchema,
  }),
  lint: Object.freeze({
    command: "lint",
    viewName: "dome.lint.report",
    schemaTag: "dome.lint.report/v1",
    bundleId: "dome.lint",
    processorName: "lint",
    payload: lintPayloadSchema,
  }),
  today: Object.freeze({
    command: "today",
    viewName: "dome.daily.today",
    schemaTag: "dome.daily.today/v1",
    bundleId: "dome.daily",
    processorName: "today",
    // The strict wire contract. Human-render adapters (CLI, HTTP) opt into
    // lenient degrade by passing a `payload: z.unknown()` override at their
    // call site and enriching via `parseTodayView`; MCP / strict consumers
    // validate against this. `buildViewModel` is intentionally unbound: the
    // tier-2 `buildTodayViewModel` consumes the enriched `TodayView`, not the
    // raw `TodayPayload`, so adapters compose it after `parseTodayView`.
    payload: todayPayloadSchema,
  }),
  taskBacklog: Object.freeze({
    command: "task-backlog",
    viewName: "dome.daily.task-backlog.list",
    schemaTag: "dome.daily.task-backlog.list/v1",
    bundleId: "dome.daily",
    processorName: "task-backlog",
    payload: taskBacklogListSchema,
  }),
} as const satisfies Record<string, FirstPartyViewEntry>;
