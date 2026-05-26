---
type: matrix
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Event types and payloads matrix

The canonical taxonomy of events Dome emits. Every event is derived from a Tool Effect or from an internal lifecycle source. Hooks subscribe to events via dotted-path patterns (most specific match wins; wildcards allowed).

## Effect-derived events

| Tool Effect | Event name | Payload fields | Typical hook handlers |
|---|---|---|---|
| `wrote-document{path, diff}` where path starts with `wiki/<type>/` | `document.written.wiki.<type>` (e.g., `document.written.wiki.entity`) | `path: string`, `category: 'wiki'`, `type: string`, `diff: UnifiedDiff` | **`auto-update-index`** (shipped default), **`auto-cross-reference`** on `wiki.entity` (shipped default), plus user-registered: notify-on-new-page, sync-to-remote |
| `wrote-document{path, diff}` where path starts with `inbox/<bucket>/` | `document.written.inbox.<bucket>` | `path: string`, `category: 'inbox'`, `bucket: string`, `diff: UnifiedDiff` | Opt-in intake handlers (`intake-raw`, `intake-voice`, `intake-research`, `intake-clip`) when vault activates them |
| `wrote-document{path, diff}` where path starts with `raw/` | `document.written.raw` | `path: string`, `category: 'raw'`, `source_type: string`, `diff: UnifiedDiff` | Notify-on-new-raw |
| `wrote-document{path, diff}` for `index.md` | `document.written.index` | `path: 'index.md'`, `diff: UnifiedDiff` | Sync, derived-cache invalidate. Note: does NOT match `document.written.wiki.*`, so `auto-update-index` doesn't loop |
| `appended-log{entry}` | `log.appended` | `entry: LogEntry`, `ts: ISODate` | Audit log shipping, alerting on certain verbs |
| `moved-document{from, to}` | `document.moved` | `from: string`, `to: string`, `category: 'wiki' \| 'inbox' \| 'notes' \| ...`, `type: string?` | Backlink-rewriting via the `auto-cross-reference` hook |
| `deleted-document{path}` | `document.deleted.<category>.<type?>` | `path: string`, `category: string`, `type: string?` | `auto-update-index` (default), orphan-detection, sync, backup-before-delete |

### `notes/` and `external/` edits — OOB-only

Out-of-band edits to `notes/` (user-authored content; Dome reads only) and `external` paths (`.git/`, unknown top-level subdirs) do NOT emit `document.written.notes.*` or `document.written.external.*` events. They emit `vault.out-of-band-edit` only — see the lifecycle events table below. Dome reconciliation does not fire content-derived events against these categories because Dome never writes there; drift only happens on user action and is captured by the OOB watcher exclusively. This keeps the asymmetric ownership clean: `notes/` is user-owned, so Dome treats every edit as OOB.

## Internal lifecycle events (not derived from Effects)

| Event | Emitter | Payload | Typical hook handlers |
|---|---|---|---|
| `vault.opened` | `openVault` | `{ path: string }` | Cache warming, sync check, plugin initialization |
| `vault.closing` | `Vault.close()` | `{ path: string }` | Cache flush, sync push |
| `vault.out-of-band-edit` | filesystem watcher when a non-Tool write is detected | `{ path: string, kind: 'created' \| 'modified' \| 'deleted' }` | Drift detection, `dome doctor` flag, optional alerting |
| `clock.tick.minutely` | clock source (when configured) | `{ ts: ISODate }` | Rare; precise scheduling |
| `clock.tick.hourly` | clock source | `{ ts: ISODate }` | Hourly maintenance hooks |
| `clock.tick.daily` | clock source | `{ ts: ISODate }` | Daily lint, daily sync |
| `clock.tick.weekly` | clock source | `{ ts: ISODate }` | Weekly review prompt, weekly synthesis page generation |
| `hook.failed` | dispatcher | `{ handler_id: string, event: string, error: Error }` | Quarantine logic, alerting |
| `hook.cycle-detected` | dispatcher | `{ chain: HookCausationChain, depth: number }` | See [[wiki/gotchas/hook-cycle]] |
| `hook.disabled` | dispatcher | `{ handler_id: string, reason: string }` | User notification |

## Pattern-matching rules

Events are dotted paths. Hooks register against patterns; the dispatcher matches most-specific-first:

| Pattern | Matches |
|---|---|
| `document.written.wiki.entity` | exact |
| `document.written.wiki.*` | any wiki-type write |
| `document.written.*` | any wiki/raw/inbox/index write |
| `document.*` | any document event (written, moved, deleted) |
| `*` | any event |

Multiple matching hooks fire in registration order; sync hooks first, async hooks after.

## Expansion convention

The declarative YAML loader at `src/hooks/yaml-loader.ts` rewrites a bare `event:` value (one with no `*` character) to `<event>.*` before registration. So `event: document.written` registers under pattern `document.written.*` and matches the projected `document.written.<category>.<type>` events the dispatcher emits. Events that already contain `*` are honored verbatim. This rewrite makes the common-case declarative form read naturally ("`event: document.written` plus `path_pattern: inbox/raw/*`") while producing the right registration pattern. Programmatic-form callers and custom YAML loaders must register `document.written.*` directly — there is no auto-expansion at the registry layer. See [[wiki/specs/hooks]] §"Bare events expand to suffix wildcards" for the canonical rule.

## Why events are derived, not fired

A Tool doesn't call `fireEvent('document.written', ...)`. It returns Effects. The Hook dispatcher consumes the Effect array and projects events automatically. This means:

- Tools cannot accidentally fire spurious events (no event without a corresponding Effect).
- Hooks cannot accidentally subscribe to events that don't exist (the taxonomy is closed and validated at load).
- Adding a new Effect kind automatically extends the event taxonomy (no parallel `fireEvent` API to maintain).

This is the architectural payoff of the four-concept core (see [[wiki/specs/sdk-surface]] §"Hook" and §"Outputs the SDK does not have"): events are derived from Effects automatically — one mutation-cum-emission API, not two.

## Plugin / vault extensions

Plugins that add Tools with new Effect kinds extend this taxonomy. The plugin's manifest declares the new Effect → Event mappings:

```yaml
# in plugin's package.json under dome.plugins.events
- effect_kind: "synced-to-remote"
  event_name: "sync.completed"
  payload_schema: { ts: ISODate, remote: string }
```

The taxonomy regenerates on plugin load. `dome doctor --show events` lists the current matrix.

## Related

- [[wiki/specs/hooks]]
- [[wiki/specs/sdk-surface]] §"Effect"
- [[wiki/invariants/HOOKS_CANNOT_BYPASS_TOOLS]]
- [[wiki/gotchas/hook-cycle]]
