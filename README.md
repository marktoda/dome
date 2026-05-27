# Dome SDK

> A compiler for your second brain.

`@dome/sdk` is the TypeScript SDK for Dome — a markdown-vault-shaped substrate that quietly keeps itself coherent over time. See [`docs/VISION.md`](docs/VISION.md) for the product framing.

This package ships four entrypoints:

- `@dome/sdk` — core (Vault, Document, Tool, Hook + the seven Tools + AbstractSurface). No LLM or MCP dependencies.
- `@dome/sdk/workflows` — LLM-driven workflow runner (`@ai-sdk/anthropic` + `ai`).
- `@dome/sdk/mcp` — MCP server (`@modelcontextprotocol/sdk`).
- `@dome/sdk/cli` — the `dome` CLI shell (`commander`).

## For contributors and agents

Start at [`AGENTS.md`](AGENTS.md) (also pointed at by [`CLAUDE.md`](CLAUDE.md) for Claude Code sessions). It carries orientation, the load-bearing rules (the named invariants, AC3 lockstep, the four-concept core), and the "Adding a new X" recipes for every common change shape.

The canonical substrate map is [`docs/index.md`](docs/index.md). Every spec, named invariant, behavior matrix, and gotcha is linked from there.

## Runtime

- TypeScript 5.x on Bun 1.x
- Tests: `bun test`
- Invariant lockstep: `bun test tests/invariants`

## License

See `LICENSE` (TBD at npm publish).
