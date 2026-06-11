// dome.daily.reconcile-tasks — propagate settled daily open-loop copies back
// to their origin task line.
//
// `carry-forward` is a read-only aggregator: checking off the generated
// source-backed copy in a daily does nothing to the origin task. This garden
// processor closes that gap — "close it in one place, close it everywhere." It
// scans the whole readable vault (siblings live in other files), collects every
// settled `- [x]/[-] body (from [[origin]])` copy, and rewrites the matching
// open origin line's checkbox marker in place. The daily's generated copy is
// never touched; past notes stay append-only.

import {
  patchEffect,
  type Effect,
  type FileChangeInput,
} from "../../../../src/core/effect";
import {
  defineProcessorImplementation,
  type ProcessorContext,
} from "../../../../src/core/processor";
import type { SourceRef } from "../../../../src/core/source-ref";

import { reconcileSettledOpenLoops } from "./open-loop-surface";

const reconcileTasks = defineProcessorImplementation({
  run: async (ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const files: { readonly path: string; readonly content: string }[] = [];
    for (const path of await ctx.snapshot.listMarkdownFiles()) {
      const content = await ctx.snapshot.readFile(path);
      if (content === null) continue;
      files.push({ path, content });
    }

    const changed = reconcileSettledOpenLoops({ files });
    if (changed.length === 0) return [];

    const writes: FileChangeInput[] = changed.map((file) => ({
      kind: "write",
      path: file.path,
      content: file.content,
    }));
    const sourceRefs: SourceRef[] = changed.map((file) =>
      ctx.sourceRef(file.path)
    );

    return [
      patchEffect({
        mode: "auto",
        changes: writes,
        reason:
          "dome.daily: propagate settled open loops back to origin task lines",
        sourceRefs,
      }),
    ];
  },
});

export default reconcileTasks;
