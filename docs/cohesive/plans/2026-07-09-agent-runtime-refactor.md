# Agent runtime seam refactor

**Date:** 2026-07-09
**Status:** complete
**Normative design:** [[wiki/specs/agent-host]]

## Objective

Make the foreground agent replaceable without changing Dome's compiler,
plugins, or mobile client. Preserve direct Markdown/Git authoring, reliable
capture, and deterministic plugin views while hard-cutting obsolete
conversation routes and speculative surface layers.

## Non-goals

- No product-shaped `VaultSurface`.
- No standardized `Context` or `WorkingSet` plugin category.
- No new core type, Effect kind, or processor phase.
- No durable server-side transcript database in this increment.
- No Claude Code or Codex process adapter yet; the shipped AI SDK adapter and
  test adapter establish the real two-adapter seam.
- No arbitrary plugin mutation handlers. Plugin mutation still flows through
  Effects, questions, proposals, or direct Markdown authoring.

## Work packages

### 1. AgentRuntime

- Add provider-neutral session, message, and event types.
- Implement an in-memory session runtime over the current AI SDK agent.
- Preserve citations, change receipts, abort behavior, and step-budget
  completion.
- Keep provider-specific stream parts inside the built-in adapter.

### 2. HTTP and PWA

- Add `POST /sessions`.
- Add `POST /sessions/:id/messages` as an SSE turn stream.
- Add `DELETE /sessions/:id`.
- Delete `/agent`, `/agent/stream`, and their provider-coupled injected
  function options; the session protocol is the only conversation path.
- Move the PWA chat path onto a persistent session while leaving capture,
  transcription, Today, recents, settlement, and resolution deterministic.

### 3. Plugin view discovery

- Expose installed command-triggered view processors through `Vault`.
- Add protocol-neutral discovery (`dome.views/v1`) and arbitrary invocation
  (`dome.view-run/v1`) operations.
- Add `dome views --json`; MCP `views` / `run_view`; and HTTP `GET /views` /
  `POST /views/:command` adapters.
- Replace the assistant's hard-coded `search_vault` / `todays_brief` parsers
  with generic `run_view` plus `read_document`.
- Do not assign roles or semantic categories to views.

### 4. Substrate alignment

- Add the agent-host spec to the substrate map.
- Update harness, client-model, HTTP, SDK, and protocol-adapter docs.
- Change generated vault orientation from “Dome views first” to “source
  first; plugin views when scope is unknown or compiled state is needed.”

### 5. Verification

- Interface-level tests for session history and isolation.
- HTTP tests for session creation, multi-turn streaming, missing sessions,
  authorization, and removal of the legacy routes.
- PWA client and app tests for session reuse.
- View-discovery tests across Vault, CLI, MCP, and HTTP.
- Full typecheck and test suite.

## Migration and compatibility

- The unreleased PWA migrates with the hard cut; legacy `/agent` routes are
  deliberately removed rather than maintained as a second architecture.
- Existing named CLI, MCP, and HTTP view operations continue to work.
- The session protocol replaces the legacy pair; the PWA becomes its first
  consumer.
- `FIRST_PARTY_VIEWS` remains the schema-aware renderer catalog for known
  first-party views. Discovery is runtime-derived and does not depend on it.
- Assistant recall is plugin-generic (`run_view` + `read_document`); named
  action tools remain for bounded mutation/decision operations.

## Completion criteria

- HTTP depends on `AgentRuntime`, not directly on AI SDK stream types for the
  new session path.
- Two conversations on the same session preserve history; different sessions
  are isolated.
- The PWA reuses one server session for its chat transcript.
- Installed plugin views can be discovered and invoked from every shipped
  client seam without changing a static catalog or agent code.
- Capture and background compilation are unaffected.
- Documentation names the agent/engine seam consistently.
- Typecheck and the full test suite pass.
