// config-document: comment-preserving `.dome/config.yaml` editing primitives.
//
// Every config editor (init's `--refresh-config` grant merge, trust-review's
// promotion diff) edits through the yaml package's Document API —
// parseDocument → targeted node edits → stringify — so hand-written comments
// and formatting on untouched nodes survive. These are the shared mechanics;
// each editor keeps its own parse/error policy (init throws, trust-review
// returns `{ok:false}`). One copy, because the mechanism is
// correctness-sensitive: divergent stringify options silently reflow an
// owner's config, and that is exactly the drift a second private mirror
// invites.

import { isMap, parseDocument, type Document, type YAMLMap } from "yaml";

/**
 * Parse a config body, requiring a top-level YAML mapping. Throwing variant
 * for callers whose outer try/catch owns error rendering (init); callers
 * with result-shaped errors (trust-review) keep their own parse.
 */
export function parseConfigDocument(body: string): Document {
  const doc = parseDocument(body);
  if (!isMap(doc.contents)) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  return doc;
}

/** `doc.contents` as a mapping (guaranteed by `parseConfigDocument`). */
export function configRoot(doc: Document): YAMLMap {
  if (!isMap(doc.contents)) {
    throw new Error(".dome/config.yaml must be a YAML mapping");
  }
  return doc.contents;
}

/**
 * `map.get(key)` when the value is a mapping, else null — the Document-API
 * analogue of `recordFromYaml(record[key])`.
 */
export function mapAt(map: YAMLMap, key: string): YAMLMap | null {
  const value = map.get(key);
  return isMap(value) ? value : null;
}

/**
 * Ensure `map[key]` is a mapping, creating (or replacing a non-mapping
 * value with) an empty one when needed. Mirrors the previous plain-object
 * behavior of `recordFromYaml(x) ?? (x = {})`.
 */
export function ensureMapAt(doc: Document, map: YAMLMap, key: string): YAMLMap {
  const existing = map.get(key);
  if (isMap(existing)) return existing;
  const created = doc.createNode({});
  map.set(doc.createNode(key), created);
  return created;
}

/**
 * Stringify with line folding disabled so long untouched lines (comments
 * survive verbatim regardless) and long inserted scalars are never
 * re-wrapped at the default 80-column width, and without flow-collection
 * padding (`["sh", ...]`, not `[ "sh", ... ]`) to match the shipped
 * default-config rendering in `src/cli/default-vault-config.ts`.
 */
export function stringifyConfigDocument(doc: Document): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
