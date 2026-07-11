import { expect } from "bun:test";
import { scenario } from "../../index";

const CONFIG = `
extensions:
  dome.agent:
    enabled: true
    grant:
      read: ["wiki/**/*.md", "inbox/processed/*.md", "core.md", "index.md"]
      patch.propose: ["wiki/**/*.md"]
      proposals.read: true
      model.invoke:
        maxDailyCostUsd: 2
`;

scenario(
  {
    name: "cli-surface: dome garden renders the shared semantic opportunity view",
    tags: [
      { kind: "group", group: "cli-surface" },
      { kind: "effect", effect: "view" },
      { kind: "phase", phase: "view" },
      { kind: "trigger", trigger: "command" },
    ],
    harness: {
      bundles: ["dome.agent"],
      initialFiles: { ".dome/config.yaml": CONFIG },
    },
  },
  async (h) => {
    expect((await h.tick()).adopted).toBe(true);
    await h.userCommit({
      files: {
        "wiki/entities/lonely.md": [
          "---",
          "description: A page with no incoming navigation",
          "status: active",
          "---",
          "# Lonely",
          "",
        ].join("\n"),
      },
      message: "add orphan page",
    });
    expect((await h.tick()).adopted).toBe(true);

    const cli = await h.runCli(["garden", "--json"]);
    expect(cli.exitCode).toBe(0);
    const payload = JSON.parse(cli.stdout) as {
      readonly name: string;
      readonly schema: string;
      readonly data: {
        readonly schema: string;
        readonly totalOpportunities: number;
        readonly opportunities: ReadonlyArray<{ kind: string; paths: ReadonlyArray<string> }>;
      };
    };
    expect(payload.name).toBe("dome.agent.garden");
    expect(payload.schema).toBe("dome.agent.garden/v1");
    expect(payload.data.totalOpportunities).toBeGreaterThan(0);
    expect(payload.data.opportunities).toContainEqual(
      expect.objectContaining({
        kind: "orphan-page",
        paths: ["wiki/entities/lonely.md"],
      }),
    );
  },
);
