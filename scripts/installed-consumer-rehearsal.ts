import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { defaultConfigYaml } from "../src/cli/default-vault-config";
import {
  CLAUDE_MD_TEMPLATE,
  DEFAULT_AGENTS_MD,
} from "../src/cli/commands/init-templates";

export type InstalledConsumerEvidence = Readonly<{
  scaffold: Readonly<{
    canonicalAgents: true;
    canonicalClaude: true;
    canonicalConfig: true;
    installedAssets: true;
    bundlesResolved: true;
  }>;
  currentSchemaReopen: Readonly<{
    attempts: 2;
    succeeded: true;
    semanticRefsStable: true;
    priorVersionUpgradeClaimed: false;
  }>;
}>;

type Run = (
  command: ReadonlyArray<string>, cwd: string, env: Readonly<Record<string, string | undefined>>,
) => Promise<Readonly<{ stdout: string }>>;

/** One source-checkout-independent CLI scaffold/init/sync/reopen acceptance journey. */
export async function verifyInstalledConsumerWorkflow(input: Readonly<{
  domeBin: string;
  installedRoot: string;
  workspace: string;
  env: Readonly<Record<string, string | undefined>>;
  run: Run;
}>): Promise<InstalledConsumerEvidence> {
  const vault = join(input.workspace, "external-vault");
  await input.run([input.domeBin, "init", vault], input.workspace, input.env);
  for (const required of [
    join(input.installedRoot, "assets", "extensions", "dome.markdown", "manifest.yaml"),
    join(input.installedRoot, "assets", "model-providers", "anthropic.ts"),
    join(input.installedRoot, "assets", "source-handlers", "claude-slack.sh"),
  ]) {
    if (!existsSync(required)) throw new Error(`installed package did not resolve asset: ${required}`);
  }
  for (const [path, expected, label] of [
    [join(vault, "AGENTS.md"), DEFAULT_AGENTS_MD, "AGENTS.md"],
    [join(vault, "CLAUDE.md"), CLAUDE_MD_TEMPLATE, "CLAUDE.md"],
    [join(vault, ".dome", "config.yaml"), defaultConfigYaml(), ".dome/config.yaml"],
  ] as const) {
    if (await readFile(path, "utf8") !== expected) {
      throw new Error(`installed minimal init produced noncanonical ${label}`);
    }
  }
  for (const retired of [
    "core.md", "wiki", "notes", "inbox", "preferences",
    ".dome/model-provider.ts", ".dome/bin",
  ]) {
    if (existsSync(join(vault, ...retired.split("/")))) {
      throw new Error(`installed minimal init recreated retired scaffold: ${retired}`);
    }
  }
  await input.run([input.domeBin, "sync", "--vault", vault, "--quiet"], input.workspace, input.env);
  const bundles = parseBundles(await input.run([
    input.domeBin, "inspect", "bundles", "--vault", vault, "--json",
  ], input.workspace, input.env));
  if (!bundles.some((row) => row.bundle === "dome.markdown" && row.loaded === true)) {
    throw new Error("installed package did not resolve the shipped dome.markdown bundle");
  }
  const first = parseStatus(await input.run([input.domeBin, "status", "--vault", vault, "--json"], input.workspace, input.env));
  const second = parseStatus(await input.run([input.domeBin, "status", "--vault", vault, "--json"], input.workspace, input.env));
  return Object.freeze({
    scaffold: Object.freeze({
      canonicalAgents: true as const,
      canonicalClaude: true as const,
      canonicalConfig: true as const,
      installedAssets: true as const,
      bundlesResolved: true as const,
    }),
    currentSchemaReopen: currentSchemaReopenEvidence(first, second),
  });
}

function parseBundles(result: Readonly<{ stdout: string }>): ReadonlyArray<Readonly<{
  bundle?: unknown;
  loaded?: unknown;
}>> {
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed)) throw new Error("installed package bundle inventory is invalid");
  return parsed as ReadonlyArray<Readonly<{ bundle?: unknown; loaded?: unknown }>>;
}

export function currentSchemaReopenEvidence(
  first: Readonly<{ head: string | null; adopted: string | null }>,
  second: Readonly<{ head: string | null; adopted: string | null }>,
): InstalledConsumerEvidence["currentSchemaReopen"] {
  if (first.head !== second.head || first.adopted !== second.adopted || first.head === null || first.adopted === null) {
    throw new Error("installed package current-schema reopen failed or changed semantic refs");
  }
  return Object.freeze({
    attempts: 2 as const,
    succeeded: true as const,
    semanticRefsStable: true as const,
    priorVersionUpgradeClaimed: false as const,
  });
}

function parseStatus(result: Readonly<{ stdout: string }>): Readonly<{ head: string | null; adopted: string | null }> {
  const parsed = JSON.parse(result.stdout) as { readonly head?: unknown; readonly adopted?: unknown };
  return Object.freeze({
    head: typeof parsed.head === "string" ? parsed.head : null,
    adopted: typeof parsed.adopted === "string" ? parsed.adopted : null,
  });
}
