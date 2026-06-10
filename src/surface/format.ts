// surface/format: canonical JSON serialization for surface documents.
//
// `formatJson(value)`: pretty-print arbitrary values as JSON. Returns a
// string; the consuming adapter (CLI handler, MCP tool) decides where it
// goes. Keeping it pure makes it trivially unit-testable.

// ----- formatJson -----------------------------------------------------------

/**
 * Pretty-print a value as JSON with 2-space indent. The returned string
 * has no trailing newline; the caller's `console.log` adds one.
 *
 * Note: this passes through to `JSON.stringify` and will throw on
 * circular references — that's a programmer error, not a runtime case.
 */
export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
