// Public CLI shell surface — `@dome/sdk/cli`. Consumers that just need the
// SDK core (Vault, Tools, Hooks, MCP) import from `@dome/sdk`; consumers
// embedding the dome CLI in their process (programmatic invocation, custom
// shells) import from here. Keeping the two entrypoints separate lets a
// v1+ shell that doesn't want the CLI surface avoid pulling Commander +
// the eight `dome <cmd>` implementations into its bundle.

export { runCli, ExitCode } from "./cli";
export { domeInit } from "./commands/init";
export { domeReconcile } from "./commands/reconcile";
export { domeDoctor, type DoctorReport } from "./commands/doctor";
export { domeLint } from "./commands/lint";
export { domeMigrate } from "./commands/migrate";
export { domeExportContext } from "./commands/export-context";
export { domeServe, type ServeHandle } from "./commands/serve";
export { domeStats } from "./commands/stats";

// CLI-layer error surface. `CliError` extends core `ToolError` with the
// pre-flight `missing-api-key` shape; `renderCliError` is the default
// one-line stderr formatter consumer shells can reuse.
export { type CliError, type MissingApiKeyError } from "./cli-error";
export { renderCliError } from "./render-error";
