// scenarios/triggers/config-and-content-one-commit.scenario.test.ts
//
// A single commit that changes BOTH `.dome/config.yaml` and an
// `inbox/raw/*.md` capture must still fire the capture's garden signal
// processors. On 2026-06-10 a grant-bump committed together with a capture
// retrigger adopted cleanly but the garden phase never ran ingest — the
// natural operator move "raise the grant to unblock ingest, retrigger in
// the same commit" silently defeated itself.

import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.inbox-signal",
);

const CONFIG_V1 = `
extensions:
  test.inbox-signal:
    enabled: true
    grant:
      read: ["inbox/**"]
      model.invoke:
        maxDailyCostUsd: 5
`;

// Same semantics, different blob: the commit must register as a config
// CHANGE (runtime-input path) while keeping the bundle enabled.
const CONFIG_V2 = `${CONFIG_V1}# bumped: budget tuning placeholder\n`;

scenario(
  {
    name: "triggers: config.yaml + inbox capture in ONE commit still fires the garden signal",
    tags: [
      { kind: "group", group: "triggers" },
      { kind: "trigger", trigger: "signal" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "garden" },
    ],
    harness: {
      bundles: [{ id: "test.inbox-signal", root: FIXTURE_BUNDLE }],
      initialFiles: { ".dome/config.yaml": CONFIG_V1 },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        ".dome/config.yaml": CONFIG_V2,
        "inbox/raw/capture.md": "a thought worth keeping\n",
      },
      message: "config: bump grant + retrigger capture (one commit)",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    const row = await h
      .expectLedger({ processorId: "test.inbox-signal.observe" })
      .toHaveAtLeastOne();
    expect(row.phase).toBe("garden");
    expect(row.status).toBe("succeeded");

    // The llm-class twin must fire too — on 2026-06-10 the deterministic
    // garden processors ran while the llm-class one (ingest) was absent
    // from the ledger entirely.
    const llmRow = await h
      .expectLedger({ processorId: "test.inbox-signal.llm-observe" })
      .toHaveAtLeastOne();
    expect(llmRow.phase).toBe("garden");
    expect(llmRow.status).toBe("succeeded");
  },
);
