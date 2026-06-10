// surface/command-error: the shared command-error document schema.
//
// Agent-facing contract: a surface verb invoked in structured mode must put
// a `dome.command-error/v1` envelope on its output channel for every failure
// outcome. The CLI's emitter lives in src/cli/command-error.ts; MCP tools
// build the envelope inline. Both cite this schema constant.

export const COMMAND_ERROR_SCHEMA = "dome.command-error/v1";
