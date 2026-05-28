// scenarios/effect-kinds/broken-images-diagnostics.scenario.test.ts
//
// dome.markdown.broken-images validates local image references through the real
// bundle/runtime/projection path. The scenario intentionally mixes an existing
// local image, a missing local image, an external image URL, and a normal link
// so the observable contract is "only missing local image embeds warn."

import { expect } from "bun:test";

import { scenario } from "../../index";

scenario(
  {
    name: "effect-kinds: dome.markdown.broken-images warns for missing local images",
    tags: [
      { kind: "group", group: "effect-kinds" },
      { kind: "effect", effect: "diagnostic" },
      { kind: "phase", phase: "adoption" },
      { kind: "capability", capability: "read" },
      { kind: "trigger", trigger: "signal" },
    ],
    harness: { bundles: ["dome.markdown"] },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    await h.userCommit({
      files: {
        "assets/logo.png": "fixture image bytes",
        "wiki/images.md":
          "---\n" +
          "type: note\n" +
          "---\n" +
          "# Images\n\n" +
          "Existing: ![logo](../assets/logo.png)\n" +
          "Missing: ![missing](../assets/missing.png)\n" +
          "External: ![remote](https://example.com/remote.png)\n" +
          "Plain link: [missing](../assets/also-missing.png)\n",
      },
      message: "add image references",
    });

    const result = await h.tick();
    expect(result.adopted).toBe(true);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-image" })
      .toHaveCount(1);

    await h
      .expectProjection()
      .diagnostics({ code: "dome.markdown.broken-image" })
      .toContainMessage("assets/missing.png");

    await h
      .expectLedger({ processorId: "dome.markdown.broken-images" })
      .toAllHaveStatus("succeeded");
  },
);
