// config-document: shared comment-preserving `.dome/config.yaml` edits.
//
// The trust-review extension parses with yaml's Document API, then uses these
// mechanics for targeted node edits and stable serialization. Keeping one
// implementation avoids reflow drift in owner-authored configuration.

import { isMap, type Document, type YAMLMap } from "yaml";

/** Return a child mapping without coercing a scalar or sequence. */
export function mapAt(map: YAMLMap, key: string): YAMLMap | null {
  const value = map.get(key);
  return isMap(value) ? value : null;
}

/** Ensure a child mapping exists, replacing a non-mapping value if needed. */
export function ensureMapAt(doc: Document, map: YAMLMap, key: string): YAMLMap {
  const existing = map.get(key);
  if (isMap(existing)) return existing;
  const created = doc.createNode({});
  map.set(doc.createNode(key), created);
  return created;
}

/** Serialize without folding long owner-authored lines or padding flow lists. */
export function stringifyConfigDocument(doc: Document): string {
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}
