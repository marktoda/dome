import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import {
  parseManifest,
  type Manifest,
} from "../../src/extensions/manifest-schema";
import {
  DEDICATED_VIEW_COMMAND_ALIASES,
} from "../../src/cli/view-command-aliases";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(dirname(THIS_FILE)));
const EXTENSIONS_ROOT = join(REPO_ROOT, "assets", "extensions");
const CLI_INDEX = join(REPO_ROOT, "src", "cli", "index.ts");
const CLI_SPEC = join(REPO_ROOT, "docs", "wiki", "specs", "cli.md");
const SCENARIOS_ROOT = join(REPO_ROOT, "tests", "harness", "scenarios");

const COMMAND_SCENARIO_FILES: ReadonlyMap<string, string> = new Map([
  ["agenda-with", "cli-surface/agenda-view.scenario.test.ts"],
  ["export-context", "cli-surface/export-context.scenario.test.ts"],
  ["lint", "cli-surface/lint-report.scenario.test.ts"],
  ["orphan-pages", "effect-kinds/view-effect-via-dome-run.scenario.test.ts"],
  ["prep", "cli-surface/prep-view.scenario.test.ts"],
  ["query", "cli-surface/query-adopted-state.scenario.test.ts"],
  ["stale-claims", "effect-kinds/stale-claims-via-dome-run.scenario.test.ts"],
  ["today", "cli-surface/today-task-view.scenario.test.ts"],
]);

type CommandTrigger = {
  readonly bundleId: string;
  readonly processorId: string;
  readonly commandName: string;
};

describe("CLI shell shape", () => {
  test("command-triggered shipped processors have a CLI route or documented dome run path", async () => {
    const commandTriggers = await shippedCommandTriggers();
    const triggerNames = new Set(commandTriggers.map((t) => t.commandName));
    const cliCommands = commandNamesFromCli(await readFile(CLI_INDEX, "utf8"));
    const cliSpec = await readFile(CLI_SPEC, "utf8");

    expect(
      commandTriggers.length,
      "expected at least one shipped command-triggered processor",
    ).toBeGreaterThan(0);

    for (
      const [commandName, alias] of DEDICATED_VIEW_COMMAND_ALIASES.entries()
    ) {
      expect(
        triggerNames.has(commandName),
        `DEDICATED_VIEW_COMMAND_ALIASES contains stale command '${commandName}'`,
      ).toBe(true);
      // An alias is an invocation ("today --prep", "audit stale-claims");
      // its first word must be a bound top-level command.
      const boundCommand = alias.split(" ")[0]!;
      expect(
        cliCommands.has(boundCommand),
        `dedicated alias '${alias}' for command '${commandName}' is not bound in src/cli/index.ts`,
      ).toBe(true);
      expect(
        cliSpec,
        `dedicated alias '${alias}' for command '${commandName}' is not documented in cli.md`,
      ).toContain(`dome ${alias}`);
    }

    for (const trigger of commandTriggers) {
      const alias = DEDICATED_VIEW_COMMAND_ALIASES.get(trigger.commandName);
      if (alias !== undefined) continue;

      const documentedRunPath = `dome run ${trigger.commandName}`;
      expect(
        cliSpec,
        `${trigger.processorId} declares command '${trigger.commandName}' but has no dedicated alias and cli.md does not document '${documentedRunPath}'`,
      ).toContain(documentedRunPath);
    }
  });

  test("every shipped command trigger has an end-to-end harness scenario", async () => {
    const commandTriggers = await shippedCommandTriggers();
    const triggerNames = new Set(commandTriggers.map((t) => t.commandName));
    const missing = [...triggerNames]
      .filter((commandName) => !COMMAND_SCENARIO_FILES.has(commandName))
      .sort();
    expect(
      missing,
      `Add scenario coverage for command trigger(s): ${missing.join(", ")}`,
    ).toEqual([]);

    const stale = [...COMMAND_SCENARIO_FILES.keys()]
      .filter((commandName) => !triggerNames.has(commandName))
      .sort();
    expect(
      stale,
      `COMMAND_SCENARIO_FILES contains stale command trigger(s): ${stale.join(", ")}`,
    ).toEqual([]);

    for (const [commandName, relativePath] of COMMAND_SCENARIO_FILES.entries()) {
      const scenarioPath = join(SCENARIOS_ROOT, relativePath);
      const body = await readFile(scenarioPath, "utf8");
      const alias = DEDICATED_VIEW_COMMAND_ALIASES.get(commandName);
      expect(
        body.includes(commandName) ||
          (alias !== undefined && body.includes(alias)),
        `${relativePath} should exercise command trigger '${commandName}'`,
      ).toBe(true);
    }
  });
});

async function shippedCommandTriggers(): Promise<ReadonlyArray<CommandTrigger>> {
  const bundles = await shippedBundles();
  const triggers: CommandTrigger[] = [];
  for (const bundle of bundles) {
    for (const processor of bundle.processors) {
      for (const trigger of processor.triggers) {
        if (trigger.kind !== "command") continue;
        expect(
          processor.phase,
          `${processor.id} declares command trigger '${trigger.name}' outside view phase`,
        ).toBe("view");
        triggers.push(Object.freeze({
          bundleId: bundle.id,
          processorId: processor.id,
          commandName: trigger.name,
        }));
      }
    }
  }
  return Object.freeze(
    triggers.sort((a, b) =>
      `${a.bundleId}:${a.commandName}`.localeCompare(
        `${b.bundleId}:${b.commandName}`,
      ),
    ),
  );
}

async function shippedBundles(): Promise<ReadonlyArray<Manifest>> {
  const dirs = await readdir(EXTENSIONS_ROOT, { withFileTypes: true });
  const bundles: Manifest[] = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    bundles.push(await readManifest(join(EXTENSIONS_ROOT, dir.name)));
  }
  return Object.freeze(bundles.sort((a, b) => a.id.localeCompare(b.id)));
}

async function readManifest(bundleRoot: string): Promise<Manifest> {
  const raw = parseYaml(await readFile(join(bundleRoot, "manifest.yaml"), "utf8"));
  const parsed = parseManifest(raw);
  expect(parsed.ok, `manifest failed to parse at ${bundleRoot}`).toBe(true);
  if (!parsed.ok) {
    throw new Error(`manifest failed to parse at ${bundleRoot}: ${parsed.error.kind}`);
  }
  return parsed.value;
}

function commandNamesFromCli(source: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\.command\("([^"]+)"/g)) {
    const name = match[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}
