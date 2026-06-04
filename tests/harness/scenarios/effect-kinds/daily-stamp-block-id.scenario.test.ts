// scenarios/effect-kinds/daily-stamp-block-id.scenario.test.ts
//
// dome.daily.stamp-block-id stamps a stable ^block-anchor onto task lines in
// the garden phase. The garden patch spawns a sub-proposal that re-adopts the
// anchored content; a subsequent tick stamps nothing more (the cascade
// converges). The stamp commit is Dome-authored, so it must not reset the
// task's human freshness signal.

import { expect } from "bun:test";

import { scenario } from "../../index";

const CONFIG = `
extensions:
  dome.daily:
    enabled: true
    grant:
      read: ["wiki/**/*.md"]
      patch.auto: ["wiki/**/*.md"]
      graph.write: ["dome.daily.*"]
      question.ask: true
`;

scenario(
  {
    name: "effect-kinds: dome.daily.stamp-block-id stamps task anchors via a garden cascade",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "patch" },
      { kind: "phase", phase: "garden" },
      { kind: "capability", capability: "patch.auto" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: {
      bundles: ["dome.daily"],
      initialFiles: { ".dome/config.yaml": CONFIG },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const path = "wiki/projects/conv.md";
    await h.userCommit({
      files: {
        [path]: ["# Conv", "", "- [ ] ship the conv follow-up #task", ""].join("\n"),
      },
      message: "add a project task",
    });

    // Adoption succeeds; the garden stamp spawns a sub-proposal that re-adopts
    // the anchored content.
    const first = await h.tick();
    expect(first.adopted).toBe(true);

    const adopted = await h.refs.adopted();
    expect(adopted).not.toBeNull();
    if (adopted === null) return;
    await h
      .expectFile(path, { atCommit: adopted })
      .toMatch(/- \[ \] ship the conv follow-up #task \^t[0-9a-f]{8}/);

    // A subsequent tick with no new user commit stamps nothing more — the
    // cascade has reached its fixed point.
    await h.tick();
    const afterSecond = await h.refs.adopted();
    await h
      .expectFile(path, { atCommit: afterSecond ?? adopted })
      .toMatch(/\^t[0-9a-f]{8}/);

    await h.expectLedger({ processorId: "dome.daily.stamp-block-id" }).toAllHaveStatus(
      "succeeded",
    );
  },
);
