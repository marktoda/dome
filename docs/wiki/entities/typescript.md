---
type: entity
description: "Dome SDK's implementation language; chosen for typed Effect/Event contracts, Zod schemas, and alignment with TS-based clients."
created: 2026-05-25
updated: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
tags: ["language"]
---

# TypeScript

Strongly-typed superset of JavaScript. Dome's SDK implementation language.

Chosen over Python after pushback in the design session: the user's familiarity (Claude Code is TS), the type system's richer expressiveness for the SDK's tool contracts (discriminated unions for `Effect` and `Event`, branded types for path safety, Zod schemas for runtime validation with derived TS types), the same-language alignment with future web client (mandatory) and React Native mobile (shared Zod schemas), and the maturity of Anthropic + MCP TypeScript SDKs.

The TS+Bun stack also makes the SDK distributable as a single npm package, embeddable in mobile shells (via Bun's compile-to-binary), and consumable from the eventual web client without language friction.

## See also

- [[wiki/entities/bun]]
- [[wiki/specs/sdk-surface]] §"Runtime"
