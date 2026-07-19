// Shared fixture for tests whose production seam requires a real Dome vault,
// but not the setup product's generated scaffold. The caller owns the path
// and cleanup; this helper owns only the invariant boundary shared by direct
// capture/settle mutations: standalone Git, named main branch, committed HEAD,
// and a present minimal Dome config.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { commit, initRepo } from "../../src/git";

export const MINIMAL_DOME_VAULT_CONFIG = "{}\n";

export async function initializeMinimalDomeVault(path: string): Promise<void> {
  await initRepo(path, "main");
  await mkdir(join(path, ".dome"), { recursive: true });
  await writeFile(
    join(path, ".dome", "config.yaml"),
    MINIMAL_DOME_VAULT_CONFIG,
    "utf8",
  );
  await commit({
    path,
    files: [".dome/config.yaml"],
    message: "fixture: initialize minimal Dome vault",
    author: { name: "fixture", email: "fixture@local" },
  });
}
