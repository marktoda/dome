# Dome SDK

> A compiler for your second brain.

`@dome/sdk` is the TypeScript SDK for Dome — a markdown-vault-shaped substrate that quietly keeps itself coherent over time. See [`docs/VISION.md`](docs/VISION.md) for the product framing.

The repository currently ships three consumer surfaces:

- `@dome/sdk` — core SDK surface for the four-concept model: Vault,
  Proposal, Processor, Effect. No LLM or MCP dependencies.
- `@dome/sdk/cli` — the Commander-based `dome` CLI dispatch surface.
- `dome mcp` and `dome http` — companion protocol adapters over the same
  capture, recall, decision, and status operations. They intentionally remain
  outside the core SDK import graph.

The day-to-day product has four jobs: **Today** presents the current action
surface and accepts captures; **Recall** retrieves source-backed context;
**Decide** routes questions and proposed garden changes to a human or agent;
**Maintain** compiles committed changes and reports operational attention.
Run `dome --help` to see commands grouped by those jobs.

## Getting started

Want to run Dome yourself — clone → vault → daemon → first morning brief?
[`docs/getting-started.md`](docs/getting-started.md) is the walkthrough,
written for someone with no Dome context and verified command-by-command
against a scratch vault. Honest caveat up front: there is no release artifact
yet; install is clone + `bun install`.

## For contributors and agents

Start at [`AGENTS.md`](AGENTS.md) (also pointed at by [`CLAUDE.md`](CLAUDE.md) for Claude Code sessions). It carries orientation, the load-bearing rules (the named invariants, AC3 lockstep, the four-concept core), and the "Adding a new X" recipes for every common change shape.

The canonical substrate map is [`docs/index.md`](docs/index.md). Every spec, named invariant, behavior matrix, and gotcha is linked from there.

## Runtime

- TypeScript 5.x on Bun 1.x
- Tests: `bun test`
- Invariant lockstep: `bun test tests/invariants`

## License

See `LICENSE` (TBD at npm publish).
