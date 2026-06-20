// Scripted model steps for the brief-basic golden case.
//
// The brief agent's task turn instructs it to read today's prepared daily,
// then fill the marker-delimited blocks. This script drives a minimal but
// realistic trajectory:
//
//   step 0 — readPage(yesterday's daily): a READ that grounds the model in
//            [[wiki/dailies/2026-06-08]] (the page it will cite).
//   step 1 — writePage(today's daily): a WRITE that replaces the yesterday
//            block body with ONE grounded bullet (the trailing `(from
//            [[wiki/dailies/2026-06-08]])` is what survives the brief's
//            grounding rule).
//   step 2 — terminal text: the agent finishes.
//
// read-before-write holds (step 0 read precedes step 1 write), so
// `trajectoryReadsBeforeWrites` passes. The brief's splice guard adopts only
// the yesterday block body; the deterministic skeleton (front matter +
// `## Open Loops` + markers) is rendered by the engine.

import type { ModelStepResponse } from "../../../../src/engine/core/model-invoke";

// Local-time anchored (matches tests/extensions/dome.agent/brief.test.ts) so
// the daily path is stable across timezones. The eval case pins the engine
// clock to this instant; the scheduler fires the brief with this `firedAt`.
export const FIRED_AT = new Date(2026, 5, 9, 5, 30).toISOString();

export const TODAY_DAILY_PATH = "wiki/dailies/2026-06-09.md";
export const YESTERDAY_DAILY_PATH = "wiki/dailies/2026-06-08.md";

const GROUNDED_YESTERDAY_BLOCK = [
  "<!-- dome.agent.brief:yesterday:start -->",
  "### Yesterday",
  `- Shipped the capture loop (from [[${YESTERDAY_DAILY_PATH.replace(/\.md$/, "")}]])`,
  "<!-- dome.agent.brief:yesterday:end -->",
].join("\n");

export const BRIEF_BASIC_SCRIPT: ReadonlyArray<ModelStepResponse> = Object.freeze([
  {
    toolCalls: Object.freeze([
      Object.freeze({
        id: "1",
        name: "readPage",
        input: { path: YESTERDAY_DAILY_PATH },
      }),
    ]),
  },
  {
    toolCalls: Object.freeze([
      Object.freeze({
        id: "2",
        name: "writePage",
        input: { path: TODAY_DAILY_PATH, content: GROUNDED_YESTERDAY_BLOCK },
      }),
    ]),
  },
  { text: "brief done" },
]);
