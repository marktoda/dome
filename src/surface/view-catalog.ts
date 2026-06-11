// surface/view-catalog: the first-party views every surface exposes.
//
// One declaration per surfaced view — command-trigger name, expected
// ViewEffect name, expected structured schema, owning bundle — consumed by
// the CLI verbs (`dome query`, `dome export-context`, `dome lint`), the MCP
// tools, and the HTTP routes. Before this catalog, the same constants were
// re-declared in three adapters; a processor rename had to be chased through
// all of them. The lockstep test (tests/surface/view-catalog.test.ts) pins
// every entry to a shipped view-phase command trigger.

export type FirstPartyViewEntry = {
  /** The command-trigger name (`vault.runView(command, …)`). */
  readonly command: string;
  /** The expected ViewEffect name the processor emits. */
  readonly viewName: string;
  /** The expected structured-content schema (`<viewName>/v1`). */
  readonly schema: string;
  /** The owning bundle (not-found messaging + lockstep). */
  readonly bundleId: string;
  /** Short processor label for operator messages. */
  readonly processorName: string;
};

export const FIRST_PARTY_VIEWS = {
  query: Object.freeze({
    command: "query",
    viewName: "dome.search.query",
    schema: "dome.search.query/v1",
    bundleId: "dome.search",
    processorName: "query",
  }),
  exportContext: Object.freeze({
    command: "export-context",
    viewName: "dome.search.export-context",
    schema: "dome.search.export-context/v1",
    bundleId: "dome.search",
    processorName: "export-context",
  }),
  lint: Object.freeze({
    command: "lint",
    viewName: "dome.lint.report",
    schema: "dome.lint.report/v1",
    bundleId: "dome.lint",
    processorName: "lint",
  }),
  today: Object.freeze({
    command: "today",
    viewName: "dome.daily.today",
    schema: "dome.daily.today/v1",
    bundleId: "dome.daily",
    processorName: "today",
  }),
} as const satisfies Record<string, FirstPartyViewEntry>;
