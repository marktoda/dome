---
type: entity
aliases:
  - Karpathy
tags:
  - researcher
  - inspiration
created: 2026-05-25
updated: 2026-06-12
sources:
  - "[[cohesive/brainstorms/2026-05-25-dome-vision]]"
  - "[[wiki/sources/karpathy-llm-wiki-gist]]"
description: "AI researcher whose LLM Wiki gist inspired Dome's compilation model: immutable raws compiled by an LLM into a linked markdown wiki."
---

# Andrej Karpathy

AI researcher and educator. Author of the LLM Wiki pattern that inspired Dome's compilation model: raw sources stay immutable; an LLM incrementally compiles them into a persistent, interlinked markdown wiki; a schema/prompt file teaches the LLM how to maintain the wiki over time.

Karpathy's framing is what unblocked Dome's design: instead of building a knowledge-graph database with a rigid ontology, build a compiler that turns raw input into structured markdown. See [[wiki/concepts/llm-wiki-pattern]] for how this translated to Dome.

## See also

- [[wiki/concepts/llm-wiki-pattern]]
- [[wiki/sources/karpathy-llm-wiki-gist]]
