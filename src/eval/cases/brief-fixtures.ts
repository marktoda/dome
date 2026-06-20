// Shared constants for the `dome.agent.brief` golden eval case.
//
// These live src-side so `src/eval/cases/brief.ts` and `scripts/eval.ts` can
// import them without an inverted src→tests dependency. The vault DATA (seed
// files, config, dailies) stays under `tests/fixtures/eval/brief-basic/vault/`
// — only the scripted model-step constants move here.

import { join } from "node:path";

import { generatedBlockMarkers } from "../../core/generated-block";
import type { ModelStepResponse } from "../../engine/core/model-invoke";

// Local-time anchored (matches tests/extensions/dome.agent/brief.test.ts) so
// the daily path is stable across timezones. The eval case pins the engine
// clock to this instant; the scheduler fires the brief with this `firedAt`.
export const FIRED_AT = new Date(2026, 5, 9, 5, 30).toISOString();

export const TODAY_DAILY_PATH = "wiki/dailies/2026-06-09.md";
export const YESTERDAY_DAILY_PATH = "wiki/dailies/2026-06-08.md";

const { start: YESTERDAY_START, end: YESTERDAY_END } = generatedBlockMarkers(
  "dome.agent.brief",
  "yesterday",
);

const GROUNDED_YESTERDAY_BLOCK = [
  YESTERDAY_START,
  "### Yesterday",
  `- Shipped the capture loop (from [[${YESTERDAY_DAILY_PATH.replace(/\.md$/, "")}]])`,
  YESTERDAY_END,
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

// Path string (not a code import) pointing at the vault seed-file tree. The
// vault DATA stays under tests/fixtures — this is just a resolved path.
export const BRIEF_FIXTURE_VAULT_DIR = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "tests",
  "fixtures",
  "eval",
  "brief-basic",
  "vault",
);
