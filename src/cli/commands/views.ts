// cli/commands/views: list command-triggered views from installed plugins.

import { openVault } from "../../vault";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";
import { collectViews } from "../../surface/views";
import { vaultOpenFailureMessage } from "../../surface/adapter";

export type RunViewsOptions = {
  readonly vault?: string | undefined;
  readonly bundlesRoot?: string | undefined;
  readonly json?: boolean | undefined;
};

export async function runViews(options: RunViewsOptions = {}): Promise<number> {
  const path = resolveVaultPath(options.vault);
  const opened = await openVault({
    path,
    ...(options.bundlesRoot !== undefined
      ? { bundlesRoot: options.bundlesRoot }
      : {}),
  });
  if (!opened.ok) {
    const message = vaultOpenFailureMessage("dome views", opened.error);
    if (options.json === true) {
      console.log(formatJson({
        schema: "dome.command-error/v1",
        status: "error",
        command: "views",
        error: opened.error.kind,
        message,
      }));
    } else {
      console.error(message);
    }
    return opened.error.kind === "not-a-vault" ? 64 : 1;
  }
  try {
    const result = collectViews(opened.value);
    if (options.json === true) {
      console.log(formatJson(result));
      return 0;
    }
    if (result.views.length === 0) {
      console.log("dome views: no plugin views installed.");
      return 0;
    }
    console.log(result.views.map((view) =>
      `${view.command}\t${view.processorId}@${view.processorVersion}\t${view.extensionId}`
    ).join("\n"));
    return 0;
  } finally {
    await opened.value.close();
  }
}
