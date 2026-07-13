// cli/commands/backup: presentation Adapter over the deep backup Module.

import {
  createVaultBackup,
  generateBackupIdentity,
  verifyVaultBackup,
  type BackupDeps,
  type BackupResult,
} from "../../backup/vault-backup";
import { formatJson } from "../../surface/format";
import { resolveVaultPath } from "../../surface/resolve-vault";

export type RunBackupOptions = {
  readonly output?: string;
  readonly recipient?: string;
  readonly identity?: string;
  readonly vault?: string;
  readonly json?: boolean;
};

export async function runBackup(
  operation: "keygen" | "create" | "verify",
  argument: string | undefined,
  options: RunBackupOptions,
  deps: BackupDeps = {},
): Promise<number> {
  let result: BackupResult;
  if (operation === "keygen") {
    if (options.output === undefined) return usage("keygen requires --output <identity-file>");
    result = await generateBackupIdentity({ output: options.output }, deps);
  } else if (operation === "create") {
    if (options.output === undefined || options.recipient === undefined) return usage("create requires --output and --recipient");
    result = await createVaultBackup({ vaultPath: resolveVaultPath(options.vault), output: options.output, recipient: options.recipient }, deps);
  } else {
    if (argument === undefined || options.identity === undefined) return usage("verify requires an archive and --identity <identity-file>");
    result = await verifyVaultBackup({ archive: argument, identity: options.identity }, deps);
  }
  present(result, options.json === true);
  return result.exitCode;
}

function usage(message: string): 64 {
  console.error(`dome backup: ${message}`);
  return 64;
}

function present(result: BackupResult, json: boolean): void {
  if (json) {
    console.log(formatJson(result));
    return;
  }
  if (result.error !== undefined) {
    console.error(`dome backup ${result.operation}: ${result.error}`);
    if (result.restart === "failed") console.error(`dome backup: Home restart failed: ${result.restartError ?? "unknown error"}`);
    return;
  }
  if (result.operation === "keygen") {
    console.log(`backup identity created: ${result.output}\nrecipient: ${result.recipient}\nKeep the identity file private; losing it makes backups unrecoverable.`);
  } else {
    console.log(`backup ${result.status}: ${result.archive}\nbackup id: ${result.backupId}\nsha256: ${result.sha256}`);
    if (result.restart === "failed") console.error(`Dome Home restart failed: ${result.restartError ?? "unknown error"}`);
  }
}
