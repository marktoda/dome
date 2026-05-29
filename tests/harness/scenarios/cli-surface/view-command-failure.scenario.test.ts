import { expect } from "bun:test";
import { join } from "node:path";

import { scenario } from "../../index";

const FIXTURE_BUNDLE = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "bundles",
  "test.throwing-view",
);

scenario(
  {
    name: "cli-surface: dome run reports throwing view processors as failures",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: [{ id: "test.throwing-view", root: FIXTURE_BUNDLE }],
      initialFiles: {
        ".dome/config.yaml": `
extensions:
  test.throwing-view:
    enabled: true
`,
      },
    },
  },
  async (h) => {
    const seed = await h.tick();
    expect(seed.adopted).toBe(true);

    const cli = await h.runCli(["run", "throw-view", "--json"]);
    expect(cli.exitCode).toBe(1);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain(
      "dome run: processor 'test.throwing-view.throw' finished with failed.",
    );
    expect(cli.stderr).toContain("processor.threw");
    expect(cli.stderr).toContain("intentional view failure");
  },
);
