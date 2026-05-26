import { domeInit } from "./commands/init";
import { domeReconcile } from "./commands/reconcile";
import { domeDoctor } from "./commands/doctor";
import { DoctorFlag } from "./doctor-flag";

const HELP = `Dome v0.5 CLI

Usage:
  dome init <path>             Bootstrap a new vault
  dome migrate <path>          Convert existing markdown to Dome shape
  dome serve --vault <path>    Start MCP server + watcher
  dome reconcile               Catch up the vault's hook state
  dome lint                    Run lint workflow against the vault
  dome doctor [flags]          Structural diagnostic check
  dome export-context <topic>  Produce a markdown context packet
`;

export const ExitCode = {
  Success: 0,
  Failure: 1,
  Usage: 2,
} as const;
export type ExitCode = typeof ExitCode[keyof typeof ExitCode];

export async function runCli(argv: ReadonlyArray<string>): Promise<ExitCode> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return ExitCode.Usage;
  }
  switch (cmd) {
    case "init": {
      const path = rest[0];
      if (!path) { console.error("dome init requires <path>"); return ExitCode.Usage; }
      const r = await domeInit(path);
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log(`Initialized Dome vault at ${r.value.path} (sha ${r.value.sha.slice(0, 7)})`);
      return ExitCode.Success;
    }
    case "reconcile": {
      const path = process.cwd();
      const r = await domeReconcile(path);
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log(`reconcile complete: ${r.value.inboxProcessed} inbox, ${r.value.changedFiles} changed, ${r.value.scheduledFired} scheduled`);
      return ExitCode.Success;
    }
    case "doctor": {
      const path = process.cwd();
      const rebuildIndex = rest.includes(DoctorFlag.RebuildIndex);
      const r = await domeDoctor(path, { rebuildIndex });
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      if (r.value.violations.length === 0) {
        console.log("doctor: clean");
        return ExitCode.Success;
      }
      for (const v of r.value.violations) console.log(`! ${v}`);
      return ExitCode.Failure;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(HELP);
      return ExitCode.Usage;
  }
}
