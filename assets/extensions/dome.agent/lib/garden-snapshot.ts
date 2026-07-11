// Snapshot adapter for the pure semantic-gardening compiler.

import type { Snapshot } from "../../../../src/core/processor";
import type { GardenDocument } from "./gardening";

export async function readGardenDocuments(
  snapshot: Snapshot,
): Promise<ReadonlyArray<GardenDocument>> {
  const paths = await snapshot.listMarkdownFiles();
  const documents = await Promise.all(paths.map(async (path) => {
    const content = await snapshot.readFile(path);
    return content === null ? null : { path, content };
  }));
  return Object.freeze(documents.filter(
    (document): document is GardenDocument => document !== null,
  ));
}
