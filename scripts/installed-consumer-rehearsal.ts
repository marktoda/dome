import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type InstalledConsumerEvidence = Readonly<{
  scaffold: Readonly<{
    modelProvider: "anthropic";
    source: "slack";
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
  await input.run([
    input.domeBin, "init", vault,
    "--with-model-provider", "anthropic",
    "--with-source", "slack",
  ], input.workspace, input.env);
  for (const required of [
    join(input.installedRoot, "assets", "extensions", "dome.markdown", "manifest.yaml"),
    join(input.installedRoot, "assets", "model-providers", "anthropic.ts"),
    join(input.installedRoot, "assets", "source-handlers", "claude-slack.sh"),
    join(vault, ".dome", "model-provider.ts"),
    join(vault, ".dome", "bin", "fetch-slack.sh"),
  ]) {
    if (!existsSync(required)) throw new Error(`installed package did not resolve asset: ${required}`);
  }
  if (await readFile(join(vault, ".dome", "model-provider.ts"), "utf8") !==
    await readFile(join(input.installedRoot, "assets", "model-providers", "anthropic.ts"), "utf8")) {
    throw new Error("installed model-provider scaffold differs from its shipped asset");
  }
  if (await readFile(join(vault, ".dome", "bin", "fetch-slack.sh"), "utf8") !==
    await readFile(join(input.installedRoot, "assets", "source-handlers", "claude-slack.sh"), "utf8")) {
    throw new Error("installed Slack scaffold differs from its shipped asset");
  }
  await input.run([input.domeBin, "sync", "--vault", vault, "--quiet"], input.workspace, input.env);
  const first = parseStatus(await input.run([input.domeBin, "status", "--vault", vault, "--json"], input.workspace, input.env));
  const second = parseStatus(await input.run([input.domeBin, "status", "--vault", vault, "--json"], input.workspace, input.env));
  return Object.freeze({
    scaffold: Object.freeze({ modelProvider: "anthropic" as const, source: "slack" as const, bundlesResolved: true as const }),
    currentSchemaReopen: currentSchemaReopenEvidence(first, second),
  });
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
