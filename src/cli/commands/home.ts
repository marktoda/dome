// cli/commands/home: the PWA-first Product Host lifecycle Adapter.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startProductHost, type ProductHost } from "../../product-host/product-host";
import { resolveHomeModelRuntime } from "../../product-host/home-model-provider";
import {
  verifyHomeArtifact,
  type HomeArtifactVerifier,
} from "../../product-host/home-artifact";
import type { ProductHostLaunch } from "../../product-host/write-admission";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

export type RunHomeOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly externalOrigin?: string | undefined;
  readonly staticDir?: string | undefined;
  readonly upgradeProbation?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onReady?: ((host: ProductHost) => void) | undefined;
};

type RunHomeDeps = Readonly<{
  startHost?: typeof startProductHost;
  resolveModel?: typeof resolveHomeModelRuntime;
  resolveLaunch?: typeof resolveInvokingHomeLaunch;
}>;

/** Start Dome Home and own its complete listener/compiler lifecycle. */
export async function runHome(options: RunHomeOptions = {}, deps: RunHomeDeps = {}): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const port = options.port === undefined ? 3663 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("dome home: --port must be an integer in [0, 65535].");
    return EX_USAGE;
  }
  const staticDir = resolve(
    options.staticDir ?? process.env["DOME_PWA_DIR"] ??
      fileURLToPath(new URL("../../../pwa/dist", import.meta.url)),
  );
  const externalOrigin = options.externalOrigin ?? process.env["DOME_EXTERNAL_ORIGIN"];
  if (!existsSync(staticDir)) {
    console.error(
      `dome home: built PWA assets were not found at ${staticDir}; run \`bun run --cwd pwa build\` or pass --static-dir.`,
    );
    return EX_USAGE;
  }
  let launch: ProductHostLaunch | undefined;
  try {
    launch = await (deps.resolveLaunch ?? resolveInvokingHomeLaunch)({
      upgradeProbation: options.upgradeProbation === true,
    });
  } catch (error) {
    console.error(`dome home: ${error instanceof Error ? error.message : String(error)}`);
    return EX_USAGE;
  }

  const modelRuntime = launch?.kind === "normal"
    ? await (deps.resolveModel ?? resolveHomeModelRuntime)(vaultPath)
    : undefined;
  const started = await (deps.startHost ?? startProductHost)({
    vaultPath,
    port,
    staticDir,
    ...(externalOrigin !== undefined
      ? { externalOrigin }
      : {}),
    ...(options.host !== undefined ? { hostname: options.host } : {}),
    ...(options.bundlesRoot !== undefined ? { bundlesRoot: options.bundlesRoot } : {}),
    ...(modelRuntime === undefined ? {} : { modelState: modelRuntime.modelState }),
    ...(modelRuntime?.modelStateResolver === undefined
      ? {}
      : { resolveModelState: modelRuntime.modelStateResolver }),
    ...(modelRuntime?.modelProvider !== undefined ? { modelProvider: modelRuntime.modelProvider } : {}),
    ...(modelRuntime?.modelStepProvider !== undefined ? { modelStepProvider: modelRuntime.modelStepProvider } : {}),
    ...(launch !== undefined ? { launch } : {}),
    ...(launch?.artifact !== undefined ? {
      productVersion: launch.artifact.version,
      assetVersion: launch.artifact.id,
    } : {}),
  });
  if (!started.ok) {
    console.error(`dome home: ${started.error.message}`);
    return started.error.kind === "open-failed" ? EX_USAGE : 1;
  }

  const host = started.value;
  try {
    console.error(`dome home: serving ${host.url}`);
    if (launch?.kind === "upgrade-probation") {
      console.error(
        `dome home: validating artifact ${launch.artifact.id} with writes disabled.`,
      );
    } else {
      console.error("dome home: mint pairing codes locally with `dome devices pair --name <device>`.");
    }
    options.onReady?.(host);
    await untilStopped(options.signal);
  } finally {
    await host.close();
  }
  return 0;
}

export async function resolveInvokingHomeLaunch(
  input: { readonly upgradeProbation: boolean },
  deps: {
    readonly artifactRoot?: string | undefined;
    readonly verifyArtifact?: HomeArtifactVerifier | undefined;
  } = {},
): Promise<ProductHostLaunch | undefined> {
  // Source checkout: src/cli/commands. Shipped artifact: app/src/cli/commands.
  const artifactRoot = resolve(deps.artifactRoot ?? resolve(import.meta.dir, "../../../.."));
  const hasManifest = existsSync(resolve(artifactRoot, "manifest.json"));
  if (!hasManifest) {
    if (input.upgradeProbation) {
      throw new Error("upgrade probation requires an invoking self-contained Home artifact");
    }
    return undefined;
  }
  const manifest = await (deps.verifyArtifact ?? verifyHomeArtifact)(artifactRoot);
  const artifact = Object.freeze({
    id: manifest.artifact.id,
    version: manifest.product.version,
  });
  return input.upgradeProbation
    ? Object.freeze({ kind: "upgrade-probation" as const, artifact })
    : Object.freeze({ kind: "normal" as const, artifact });
}

async function untilStopped(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((done) => {
    const finish = (): void => {
      process.removeListener("SIGINT", finish);
      process.removeListener("SIGTERM", finish);
      signal?.removeEventListener("abort", finish);
      done();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    if (signal?.aborted === true) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}
