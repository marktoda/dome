# Dome

**A local, self-tending operating system for your second brain.**

Dome turns an Obsidian-compatible Markdown vault into a living workspace. It
helps you begin the day with context, capture ideas before they disappear, ask
questions across your history, make explicit decisions about old commitments,
and keep a growing body of knowledge coherent.

Your files stay ordinary Markdown. Git records their history. Dome's indexes
can be rebuilt, and its processors cannot bypass the capability-checked engine
to change trusted state. You can keep editing with Obsidian, a coding agent, or
any other tool that works with files and Git.

## The daily loop

- **Today** brings together a source-backed morning brief, meetings, urgent
  work, unresolved decisions, and operational attention.
- **Capture** saves a text thought for review and filing. Capture can be queued
  offline; Dome reports whether it is local, sending,
  filed, or not confirmed instead of pretending every request succeeded.
- **Ask** answers questions from adopted vault content and links back to the
  Markdown sources behind the answer.
- **Backlog Review** turns an overwhelming task inventory into small batches.
  Every source remains visible, and every commitment receives an explicit
  leave-open, defer, or close decision.
- **Garden** processors find stale structure, broken links, duplicate or
  conflicting knowledge, and synthesis opportunities. Bounded ingestion and
  daily-maintenance processors can apply deterministic repairs; the nightly
  semantic garden emits reviewable proposals only.

Dome Home is the product: a supervised engine on your Mac and an installable
PWA for desktop and mobile browsers. The CLI, SDK, and MCP adapter expose the
same underlying vault and engine for agents and automation.

## Current preview

Dome is currently a technical preview with this supported shape:

There is not yet a public download. The supported preview is built from a
clean source checkout and installed as a versioned Home artifact.

| | Current support |
|---|---|
| Owner | One owner |
| Vault | One Markdown/Git vault per Dome Home process |
| Host | Apple Silicon macOS, supervised by `launchd` |
| Clients | Multiple individually paired browsers; loopback or a separately configured private Tailscale connection |
| Models | Anthropic is the shipped provider; deterministic vault, capture, task, and Today behavior degrades independently when the model is unavailable |
| Distribution | Source-built, versioned Home artifact; no public package or download yet |
| Signing | Preview artifacts are not Apple-notarized; Dome does not disable Gatekeeper or remove quarantine for you |

There is no multi-owner collaboration, hosted sync service, or public-internet
deployment in this release. Markdown and Git remain portable if you stop using
Dome.

## Try it from source

You need Apple Silicon macOS, Bun 1.x, Git, and a current stable Google Chrome.
The artifact builder uses Chrome for its installed-product acceptance gate and
requires a clean checkout.

```sh
git clone https://github.com/marktoda/dome.git
cd dome
bun install --frozen-lockfile
bun run build:home-artifact -- --output "$HOME/Dome-artifact"
```

The build prints the expanded artifact's `directory`. Use its exact CLI for
vault setup and installation:

```sh
DOME="/path/from-the-directory-field/bin/dome"
"$DOME" --help
```

Continue with the [Dome Home getting-started guide](https://github.com/marktoda/dome/blob/main/docs/getting-started.md).
It covers creating or adopting a vault, configuring the model provider,
installing Home, pairing the PWA, the first Capture and Ask, updates, encrypted
backup, restore, and recovery.

For an **existing vault**, `dome init` adds only missing Dome scaffolding and
preserves owner files; an ordinary rerun is idempotent. You review and commit
the additions before Home starts. Dome does not silently reorganize the vault.
For a **new vault**, it creates the minimal Git-backed structure, orientation,
configuration, and first commit without filling it with fake example content.

The planned no-checkout installation is:

```sh
bun install -g @marktoda/dome
dome setup
```

That package is **not published yet**. The current source-built path above is
the only documented installation path; the registry command is the next
distribution milestone.

## How it works

Dome's core has four concepts: **Vault, Proposal, Processor, and Effect**.
Human and agent commits become proposals. Processors read immutable candidate
state and return effects. The engine validates and capability-checks every
effect, applies deterministic patches to a fixed point, and advances a separate
adopted Git reference only after the result is coherent. Recall reads that
adopted state rather than racing unfinished edits.

Markdown and Git hold durable knowledge. SQLite holds both rebuildable
projections and local operational state such as answers, audit history, retry
state, and recovery state; backups preserve the latter because it cannot be
fully rebuilt from Markdown. Model calls and protocol adapters live outside the
sealed SDK core.

Start with:

- [Architecture overview](https://github.com/marktoda/dome/blob/main/architecture.md)
- [Canonical design substrate](https://github.com/marktoda/dome/blob/main/docs/index.md)
- [Product-host contract](https://github.com/marktoda/dome/blob/main/docs/wiki/specs/product-host.md)
- [SDK surface and extension guide](https://github.com/marktoda/dome/blob/main/docs/wiki/specs/sdk-surface.md)

## Develop and contribute

Read [AGENTS.md](https://github.com/marktoda/dome/blob/main/AGENTS.md) before
changing the code, then use the [substrate index](https://github.com/marktoda/dome/blob/main/docs/index.md)
to find the relevant specification, invariant, matrix, and gotcha.

```sh
bun install
bun run typecheck
bun test ./tests
```

Useful narrower gates include `bun test tests/invariants`, `bun run check:pwa`,
and `bin/dome <command>` for a local CLI invocation. The package currently
exports `@dome/sdk`, `@dome/sdk/cli`, and `@dome/sdk/mcp`; its public rename to
`@marktoda/dome` belongs to the registry-distribution milestone.

## License

MIT has been selected for public distribution. The repository does not yet
contain the license file, so no public package should be published until that
file is committed as part of the distribution work.
