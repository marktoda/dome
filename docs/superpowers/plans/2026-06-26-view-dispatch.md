# View Dispatch Implementation Plan (on `main`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Collapse the three protocol adapters' duplicated catalog-view plumbing onto one deep, generic `dispatchView` module behind a small per-protocol `ViewRenderer` seam.

**Architecture:** `src/surface/adapter.ts` already has `withVault` + `runCatalogView<TPayload>` (typed View Contract: `viewName` + `schemaTag` + zod `payload`, problems-as-data incl. `invalid-payload`) + `catalogViewProblemMessage`/`catalogViewProblemExitCode`. Three adapters re-implement the dispatch on top: MCP `structuredViewResult<TPayload>`, HTTP's three open-coded routes (`/tasks`, `/query`, `/today`), and the CLI's separate `runStructuredViewCommand<TPayload>` (a second vault-open path via `runSharedViewCommand`). Add `dispatchView<TPayload, TEnvelope>(locator, entry, args, renderer)`: open → run → validate → route the three outcomes (open-failed / problem / ok) to a `ViewRenderer<TEnvelope>` (error branches, protocol-uniform) or back to the caller (ok; per-route JSON/HTML/stderr). Retire `runStructuredViewCommand`.

**History:** A first pass was built+reviewed on a stale base (`origin/main` = `e3443c0`, 227 commits behind local `main`). The design, plan, and two code reviews validated there; this plan re-applies them against current `main` (`a02a248`), which has the **generic typed contract** (vs the stale base's non-generic `schema`-only one). The review's two fixes are folded in from the start: (1) preserve the `view-command-failed` tag on the CLI throw path via a two-tier catch; (2) a direct `cliProblemMessages` byte-identity unit test.

## Global Constraints

- BEHAVIOR-PRESERVING: CLI exit codes + stderr lines, HTTP status + bodies, MCP tool JSON byte-identical. Existing adapter suites are the gates.
- `@dome/sdk` core gains no LLM/MCP dep (`dispatchView` in `src/surface/adapter.ts`).
- Generic: thread `<TPayload>` so `dispatchView` returns typed `ok` data (matches `runCatalogView<TPayload>`).
- Out of scope: `runSharedViewCommand` (used by `dome today`/`dome run`), `structuredViewBrokerMessages`, `status`/`check` collectors, `GET /status`, capture/resolve/recents/doc, the `dome today` CLI command.
- The HTTP `/tasks` + `/today` lenient override (`{ ...FIRST_PARTY_VIEWS.today, payload: z.unknown() }`) stays ad-hoc — pass the lenient entry to `dispatchView`.
- Pre-existing baseline: run `bunx tsc --noEmit` and record the error count BEFORE changes; the change must add zero new errors. Scoped suites only (`tests/surface tests/mcp tests/http tests/cli`), not the full flaky suite.

## File Structure

- `src/surface/adapter.ts` — MODIFY: add `ViewRenderer<TEnvelope>`, `ViewDispatch<TPayload,TEnvelope>`, `dispatchView<TPayload,TEnvelope>` after `catalogViewProblemExitCode`.
- `tests/surface/view-dispatch.test.ts` — CREATE: open-failed routing unit test + recording renderer.
- `src/mcp/server.ts` — MODIFY: `structuredViewResult` body → `dispatchView` + `mcpViewRenderer`; delete `viewError`.
- `src/http/server.ts` — MODIFY: add `httpViewRenderer`; rewrite `/tasks`, `/query`, `/today` onto `dispatchView`.
- `src/cli/structured-view-command.ts` — MODIFY: `runCliStructuredView` → `dispatchView` + `cliViewRenderer`; add exported `cliProblemMessages`; two-tier catch.
- `tests/cli/commands/cli-problem-messages.test.ts` — CREATE: byte-identity of `cliProblemMessages`.
- `src/surface/view.ts` — MODIFY: delete `runStructuredViewCommand` + its types + `structuredError`; keep `runSharedViewCommand`, `structuredViewBrokerMessages`.
- `docs/glossary.md` — MODIFY: add "View dispatch".

## Interfaces produced (Task 1)

```ts
export type ViewRenderer<TEnvelope> = {
  readonly openFailed: (error: OpenVaultError) => TEnvelope;
  readonly problem: (problem: CatalogViewProblem) => TEnvelope;
};
export type ViewDispatch<TPayload, TEnvelope> =
  | { readonly kind: "ok"; readonly data: TPayload; readonly brokerDiagnostics: ReadonlyArray<DiagnosticEffect> }
  | { readonly kind: "rendered"; readonly envelope: TEnvelope };
export async function dispatchView<TPayload, TEnvelope>(
  locator: { readonly path: string; readonly bundlesRoot?: string | undefined },
  entry: FirstPartyViewEntry<TPayload>,
  args: unknown,
  renderer: ViewRenderer<TEnvelope>,
): Promise<ViewDispatch<TPayload, TEnvelope>>;
```

## Tasks (each: baseline-green → edit → scoped suite + tsc(no new errors) → commit)

1. **Core** — add the three exports to `adapter.ts`; create `tests/surface/view-dispatch.test.ts` (open-failed branch via non-vault temp dir + recording renderer).
2. **MCP** — replace `structuredViewResult` body with `dispatchView` + `mcpViewRenderer` (envelope `ToolResult`); delete `viewError`; keep the `{ok|error}` return shape so the 4 call sites are untouched. Gate: `tests/mcp/mcp-server.test.ts`.
3. **HTTP** — add `httpViewRenderer(route, entry): ViewRenderer<Response>` (open→`commandErrorResponse`, problem→`dataErrorResponse(viewProblemHttpStatus(p), p.kind, catalogViewProblemMessage(...))`); rewrite all three routes to `dispatchView` (`/tasks`,`/today` keep the lenient entry; `/today` renders HTML on ok). Import `FirstPartyViewEntry`. Gate: `tests/http`.
4. **CLI** — `runCliStructuredView<TPayload>` → `dispatchView` + `cliViewRenderer` (envelope `number`, prints then returns exit code); exported `cliProblemMessages` reproducing the no-structured-result override + processor-failed multi-line expansion; **two-tier catch** (inner around `dispatchView` → `view-command-failed` no tag; outer → `failedError`); resolve vault path via `resolveVaultPath(opts.vault)`. Delete `runStructuredViewCommand` + types + `structuredError` from `view.ts`, prune now-unused imports. Create `tests/cli/commands/cli-problem-messages.test.ts`. Gates: `tests/cli`, `tests/surface`.
5. **Verify+merge** — add glossary "View dispatch"; run `tests/surface tests/mcp tests/http tests/cli` + structural fences (`bundle-deps`, `surface-adapter-imports`, `public-surface-shape`); `tsc` no new errors; deletion-test (`grep runCatalogView src/mcp src/http src/cli` → none); then finish the branch.
