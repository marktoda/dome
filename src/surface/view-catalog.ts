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
    payload: z.unknown(),
  }),
  exportContext: Object.freeze({
    command: "export-context",
    viewName: "dome.search.export-context",
    schemaTag: "dome.search.export-context/v1",
    bundleId: "dome.search",
    processorName: "export-context",
    payload: z.unknown(),
  }),
  lint: Object.freeze({
    command: "lint",
    viewName: "dome.lint.report",
    schemaTag: "dome.lint.report/v1",
    bundleId: "dome.lint",
    processorName: "lint",
    payload: z.unknown(),
  }),
  today: Object.freeze({
    command: "today",
    viewName: "dome.daily.today",
    schemaTag: "dome.daily.today/v1",
    bundleId: "dome.daily",
    processorName: "today",
    payload: z.unknown(),
  }),
} as const satisfies Record<string, FirstPartyViewEntry>;
