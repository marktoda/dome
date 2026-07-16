# Dome

> A self-tending second brain, built on your Markdown and Git vault.

Dome Home is the product: a supervised local engine and installable PWA for
capturing thoughts, asking source-backed questions, seeing the day, and keeping
a growing vault coherent. Your Markdown and Git history remain the durable
source of truth. The first supported beta is one owner, one vault, and multiple
paired browsers, hosted on Apple Silicon macOS.

The product has four jobs: **Today** presents the current action surface and
accepts captures; **Recall** retrieves source-backed context; **Decide** routes
questions and proposed garden changes; **Maintain** compiles committed changes
and reports operational attention.

## Start with Dome Home

There is not yet a public download or package-registry release. Use a reviewed
Dome Home artifact supplied by the project owner, or build one from a clean
checkout. Then initialize a new or existing vault, store the model credential
in macOS Keychain, install Home, pair a browser, and make the first capture.

The complete, command-by-command path is in
[`docs/getting-started.md`](https://github.com/marktoda/dome/blob/main/docs/getting-started.md).
It also covers upgrades, encrypted backups, restore, and recovery. The PWA at
Home's root URL is the canonical user interface; standalone `dome serve` and
`dome http` are compatibility/operator surfaces, not alternate onboarding
paths.

## SDK and contributors

This repository also contains the TypeScript SDK and companion adapters:

- `@dome/sdk` — the four-concept core: Vault, Proposal, Processor, Effect.
- `@dome/sdk/cli` — the Commander CLI dispatch surface.
- `dome mcp` — the stdio adapter for foreground agent harnesses.

Contributors and coding agents should start at
[`AGENTS.md`](https://github.com/marktoda/dome/blob/main/AGENTS.md), then use
[`docs/index.md`](https://github.com/marktoda/dome/blob/main/docs/index.md) as
the canonical map of specs, invariants, matrices, and gotchas.

Local development requires Bun 1.x. Run `bun install`, then `bun test`; the
invariant-only suite is `bun test tests/invariants`.

## License

No license file has been selected yet. The project must make that decision
before any public distribution.
