// dome.lint.markdown-format — Phase 8 demo view-phase processor.
//
// Purpose: prove the v1 stack runs end-to-end with a bundle-loaded
// processor. The full lint logic (walking the wiki, applying checks,
// emitting per-finding diagnostics) is a Phase 9 (CLI) concern; this
// processor is the minimum surface the bundle loader needs to bind +
// register + the engine needs to route.
//
// Per [[wiki/matrices/built-in-extensions-x-phase]], `dome.lint` is a
// view-phase bundle. The shipped-Phase-9 processor declares two triggers
// (command `lint` + cron `0 7 * * MON`); the Phase 8 version only the
// command — the schedule wiring lands when the scheduler ships.
//
// This file lives under `assets/` which is excluded from the root
// `tsconfig.json`. The import paths below are relative paths into `src/`
// resolved at runtime by Bun; the file is not typechecked as part of
// `tsc --noEmit`.

import { viewEffect, type Effect } from "../../../../src/core/effect";
import {
  defineProcessor,
  type Processor,
  type ProcessorContext,
} from "../../../../src/core/processor";

const markdownFormat: Processor = defineProcessor({
  id: "dome.lint.markdown-format",
  version: "0.1.0",
  phase: "view",
  triggers: [{ kind: "command", name: "lint" }],
  capabilities: [],
  run: async (_ctx: ProcessorContext): Promise<ReadonlyArray<Effect>> => {
    const effect: Effect = viewEffect({
      name: "markdown-format-report",
      content: {
        kind: "structured",
        data: { status: "ok", checked: 0, issues: [] },
        schema: "dome.lint.markdown-format/v0",
      },
      scope: [],
    });
    return [effect];
  },
});

export default markdownFormat;
