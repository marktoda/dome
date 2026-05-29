---
type: entity
created: 2026-05-25
updated: 2026-05-29
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tags: ["runtime", "toolkit"]
---

# Bun

JavaScript runtime + bundler + package manager + test runner. Dome's v1 SDK and CLI runtime.

Chosen over Node.js after the language pivot to TypeScript because: native TS support (no `tsc` step), built-in test runner (no `vitest` config), single-binary distribution (`bun build --compile` produces standalone executables for v1+ embedded contexts), fast startup (matters for CLI invocations), built-in file watcher and JSON-RPC support (useful for the MCP server).

Trade-offs: Node-only native modules occasionally break under Bun. The Dome SDK avoids native modules where possible and tests the few it depends on (filesystem watcher, fast markdown parser) explicitly under Bun.

## See also

- [[wiki/entities/typescript]]
- [[wiki/specs/sdk-surface]] §"Runtime"
- [[wiki/specs/cli]]
