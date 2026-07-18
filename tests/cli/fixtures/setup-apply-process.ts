import {
  createSetupPlanApplier,
  failSetupAfter,
  SETUP_DURABLE_BOUNDARIES,
  type SetupDurableBoundary,
} from "../../../src/setup/apply";
import type { SetupCompilerInput } from "../../../src/setup/compiler";
import { runSetup } from "../../../src/cli/commands/setup";
import { inspectSetupVaultSource } from "../../../src/setup/vault-inspector";

const [target, plan, consent, boundaryInput] = process.argv.slice(2);
if (target === undefined || plan === undefined || consent === undefined) {
  throw new Error("setup process fixture requires target, plan, and consent");
}
const boundary = boundaryInput === undefined ? null : boundaryInput as SetupDurableBoundary;
if (boundary !== null && !SETUP_DURABLE_BOUNDARIES.includes(boundary)) {
  throw new Error("setup process fixture boundary is invalid");
}

const HEAD = "1".repeat(40);
const HASH = "2".repeat(64);
const scope = { version: 1 as const, include: ["**/*.md"], exclude: [".dome/**", ".git/**"] };
const scaffold = {
  agentsOrientation: "# Dome vault\n",
  claudeOrientation: "@AGENTS.md\n",
  gitignore: ".dome/state/\n",
  vaultConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
  contentScopeConfig: "content_scope:\n  version: 1\n  include: [\"**/*.md\"]\n  exclude: [\".dome/**\", \".git/**\"]\n",
};

async function discover(path: string): Promise<SetupCompilerInput> {
  return {
    source: await inspectSetupVaultSource(path),
    host: { platform: "darwin", architecture: "arm64" },
    prerequisites: { bun: "1.2.13", git: "2.50.1" },
    product: {
      distribution: "packaged",
      packageName: "@marktoda/dome",
      packageVersion: "0.4.0",
      sourceCommit: HEAD,
      productManifestSha256: HASH,
      packagedHome: {
        artifactId: HASH,
        productVersion: "0.4.0",
        buildCommit: HEAD,
        manifestSha256: HASH,
      },
    },
    installedHome: {
      state: "absent", artifactId: null, productVersion: null, buildCommit: null,
      manifestSha256: null, selectedVaultPath: null,
    },
    contentScope: scope,
    scaffold,
  };
}

const discovery = { contentScope: scope, scaffold };
const apply = createSetupPlanApplier({
  discovery,
  discover,
  ...(boundary === null ? {} : { afterBoundary: failSetupAfter(boundary) }),
});
const code = await runSetup({ path: target, apply: true, plan, consent, json: true }, {
  ...discovery,
  discover,
  apply,
});
process.exit(code);
