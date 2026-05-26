import { domeInit } from "./commands/init";
import { domeReconcile } from "./commands/reconcile";
import { domeDoctor, type DoctorOpts } from "./commands/doctor";
import { domeMigrate } from "./commands/migrate";
import { domeLint } from "./commands/lint";
import { domeExportContext } from "./commands/export-context";
import { domeServe } from "./commands/serve";
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

// Translate `--show <subject>` token-pairs into DoctorFlag values; passthrough
// the single-token flags. Returns a parsed DoctorOpts and a list of unknown
// tokens (which is non-empty iff the user passed something we don't recognize).
function parseDoctorArgs(argv: ReadonlyArray<string>): { opts: DoctorOpts; unknown: string[] } {
  const opts: DoctorOpts = {};
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === DoctorFlag.RebuildIndex) { opts.rebuildIndex = true; continue; }
    if (arg === "--recent-activity") { opts.recentActivity = true; continue; }
    if (arg === "--drain-hooks") { opts.drainHooks = true; continue; }
    if (arg === "--reset-quarantined-hooks") { opts.resetQuarantinedHooks = true; continue; }
    if (arg === "--show") {
      const subject = argv[i + 1];
      i++;
      if (subject === "review-queue") opts.showReviewQueue = true;
      else if (subject === "raw-citations") opts.showRawCitations = true;
      else if (subject === "workflows") opts.showWorkflows = true;
      else if (subject === "events") opts.showEvents = true;
      else if (subject === "recent-hook-cycles") opts.showRecentHookCycles = true;
      else unknown.push(`--show ${subject ?? ""}`.trim());
      continue;
    }
    unknown.push(arg);
  }
  return { opts, unknown };
}

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
    case "migrate": {
      const path = rest[0];
      if (!path) { console.error("dome migrate requires <path>"); return ExitCode.Usage; }
      const apply = rest.includes("--apply");
      const r = await domeMigrate(path, apply, {});
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log(`migrate complete: ${r.value.steps} step(s)`);
      return ExitCode.Success;
    }
    case "serve": {
      // Parse --vault <path>; fall back to cwd.
      const vIdx = rest.indexOf("--vault");
      const path = vIdx >= 0 ? rest[vIdx + 1] : process.cwd();
      if (!path) { console.error("dome serve --vault <path> requires a path"); return ExitCode.Usage; }
      const r = await domeServe(path);
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log("MCP server started; press Ctrl-C to stop");
      // v0.5: keep the process alive. Full daemonization (signal handling,
      // graceful stop, log rotation) is deferred to v1.
      await new Promise<void>(() => {});
      return ExitCode.Success;
    }
    case "reconcile": {
      const path = process.cwd();
      const r = await domeReconcile(path);
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log(`reconcile complete: ${r.value.inboxProcessed} inbox, ${r.value.changedFiles} changed, ${r.value.scheduledFired} scheduled`);
      return ExitCode.Success;
    }
    case "lint": {
      const path = process.cwd();
      const r = await domeLint(path, {});
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log(`lint complete: ${r.value.steps} step(s)`);
      return ExitCode.Success;
    }
    case "export-context": {
      const topic = rest[0];
      if (!topic) { console.error("dome export-context requires <topic>"); return ExitCode.Usage; }
      const path = process.cwd();
      const r = await domeExportContext(path, topic, {});
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      console.log(`export-context complete: ${r.value.steps} step(s)`);
      return ExitCode.Success;
    }
    case "doctor": {
      const path = process.cwd();
      const { opts, unknown } = parseDoctorArgs(rest);
      if (unknown.length > 0) {
        console.error(`Unknown doctor flag(s): ${unknown.join(", ")}`);
        return ExitCode.Usage;
      }
      const r = await domeDoctor(path, opts);
      if (!r.ok) { console.error(JSON.stringify(r.error)); return ExitCode.Failure; }
      for (const line of r.value.info) console.log(line);
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
