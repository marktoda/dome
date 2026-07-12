// cli/commands/home: the PWA-first Product Host lifecycle Adapter.

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startProductHost, type ProductHost } from "../../product-host/product-host";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { EX_USAGE } from "../exit-codes";

export type RunHomeOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly port?: string | number | undefined;
  readonly host?: string | undefined;
  readonly pairCode?: string | undefined;
  readonly staticDir?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onReady?: ((host: ProductHost, pairCode: string) => void) | undefined;
};

/** Start Dome Home and own its complete listener/compiler lifecycle. */
export async function runHome(options: RunHomeOptions = {}): Promise<number> {
  const vaultPath = resolveVaultPath(options.vault);
  const pairCode = (
    options.pairCode ?? process.env["DOME_PAIR_CODE"] ?? randomBytes(8).toString("hex")
  ).trim();
  if (pairCode.length < 8) {
    console.error("dome home: --pair-code must contain at least 8 characters.");
    return EX_USAGE;
  }
  const port = options.port === undefined ? 3663 : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("dome home: --port must be an integer in [0, 65535].");
    return EX_USAGE;
  }
  const staticDir = resolve(
    options.staticDir ?? process.env["DOME_PWA_DIR"] ??
      fileURLToPath(new URL("../../../pwa/dist", import.meta.url)),
  );
  if (!existsSync(staticDir)) {
    console.error(
      `dome home: built PWA assets were not found at ${staticDir}; run \`bun run --cwd pwa build\` or pass --static-dir.`,
    );
    return EX_USAGE;
  }

  const started = await startProductHost({
    vaultPath,
    pairCode,
    port,
    staticDir,
    ...(options.host !== undefined ? { hostname: options.host } : {}),
    ...(options.bundlesRoot !== undefined ? { bundlesRoot: options.bundlesRoot } : {}),
  });
  if (!started.ok) {
    console.error(`dome home: ${started.error.message}`);
    return started.error.kind === "open-failed" ? EX_USAGE : 1;
  }

  const host = started.value;
  console.error(`dome home: serving ${host.url}`);
  console.error(`dome home: local pairing code ${pairCode}`);
  options.onReady?.(host, pairCode);
  try {
    await untilStopped(options.signal);
  } finally {
    await host.close();
  }
  return 0;
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
