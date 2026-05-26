---
type: invariant
created: 2026-05-26
updated: 2026-05-26
sources: ["[[wiki/specs/prompts-and-workflows]]", "[[wiki/gotchas/agent-prompt-regression]]"]
tier: axiom
---

# WORKFLOWS_KNOW_VAULT_CONTEXT

**Tier:** Axiom — non-disable-able.

**Statement:** Every workflow's `system` parameter to `generateText` is prepended with a composed set of **preambles** registered in `SYSTEM_PREAMBLES` (`src/workflows/agent-loop.ts`). At minimum the registry carries:

- **`vaultIdentityPreamble`** — names `vault.path` so prompt bodies that say "the vault" or "the directory" have an anchor.
- **`renderingSurfacePreamble`** — tells the LLM its reply is the workflow's final terminal output (or, for hook-driven runs, is discarded), that there is no conversational follow-up channel, and that next-step guidance should name the next CLI command rather than address a chat shell that does not exist.

New preambles are added by writing a `Preamble` function and appending to `SYSTEM_PREAMBLES`; the composer `buildSystemPreamble(vault)` is the single seam every workflow runs through.

**Why:** Workflow prompts are vault-shaped and surface-blind — they say things like "convert the directory," "walk the vault," "write the proposal to `.dome/migration-plan.md`." Tools are vault-bound at construction, but the LLM itself has no other channel to learn the vault's identity or the rendering surface its reply will appear on. Without preambles:

- The vault path is unknown — `dome migrate <path>` passed `""` as the user message, the migrate prompt referenced `<path>` as a literal placeholder with no plumbing behind it, and the LLM completed in one step by asking the user for the path the CLI had already supplied.
- The rendering surface is unknown — workflow output ends up shaped like chat prose ("say apply the plan", "if you want to, answer those questions") even though it's rendered into a terminal that has no reply channel.

Both failures share a single substrate gap: **the LLM driving a workflow needs to know what situation it's in**, and the runner is the only place that knows.

**Structural enforcement:** `runWorkflow` constructs the `system` parameter as `${buildSystemPreamble(vault)}\n\n${def.body}`. There is no code path in `runWorkflow` that passes `def.body` to `generateText` without the composed preamble. `buildSystemPreamble` filters out empty-string preamble outputs and joins the remaining sections with blank lines, so each preamble can opt out at runtime (return `""`) without breaking the structure.

The separation is principled: **preambles describe the situation** (which vault, which surface, what date), **the workflow body describes the task**, **the user message carries the specific instruction** (and doubles as the commit subject via `subjectFromUserMessage`). CLI shims that drive workflows non-interactively are obligated to send a meaningful task description in the user message; they are NOT obligated to thread vault path or rendering hints through it.

**Counter-example:** A new workflow `dome catalog` is added with a CLI shim that calls `runWorkflowAtPath(path, "catalog", "")`. The catalog prompt body says "Walk the vault root and enumerate top-level directories." Without the preambles, the LLM asks "which vault?" *and* assumes a conversational reply channel ("Want me to filter by category?"). With the preambles, the LLM proceeds against the named vault and produces a terminal-shaped summary that names the next CLI command rather than asking follow-ups.

Inverse counter-example: the migrate prompt's old form, `Convert the directory at <path> to a Dome vault.`, attempted to encode the context in the prompt body via a literal placeholder. There is no template substitution in `PromptLoader` — only `{{include: name.md}}` — so `<path>` was prose, not a variable. The preamble registry replaces this pattern: prompt bodies refer to "the current vault" and situational context lives in registered preambles.

**Test guarantee:**
- `tests/workflows/agent-loop.test.ts` —
  - *"prepends a vault-identity preamble naming vault.path to the system prompt"* asserts `system` contains `vault.path` after `runWorkflow` runs against a `MockLanguageModelV3` spy.
  - *"prepends a rendering-surface preamble describing non-interactive single-turn semantics"* asserts the surface preamble's stable phrasing ("non-interactive", "CLI") appears in the captured system prompt.
  - *"`buildSystemPreamble` composes every registered preamble with blank-line separators"* pins the composer's contract directly (no runner involvement) — every entry in `SYSTEM_PREAMBLES` contributes a section, and sections are separated by blank lines.
- `tests/cli/migrate-bootstrap.test.ts` — *"LLM receives vault.path in system prompt and a task description in the user message"* pins the end-to-end boundary for the specific command whose absence motivated this invariant; an analogous assertion should be added to every future workflow-driven CLI command.

**Why an axiom (not configurable):**
- Situational context is structural, not stylistic. There is no user-meaningful "disable the preambles" mode — disabling them just breaks workflows.
- The preambles are short and uniform across vaults. The cost of always including them is negligible against the cost of any caller forgetting them.
- Unlike `SENSITIVE_GOES_TO_INBOX` (a routing policy a project vault may not need) or `PAGE_CREATION_REQUIRES_RECURRENCE` (a discipline some users want and others don't), `WORKFLOWS_KNOW_VAULT_CONTEXT` is a contract between the runner and every prompt body. There is no defensible "off" position.

**Extension model:** Future situational context the LLM should always know (today's date for time-sensitive workflows, currently-enabled invariant set for vault-config-aware behavior, recent activity hints to bias toward continuity, etc.) lands as a new `Preamble` registered in `SYSTEM_PREAMBLES`. Each preamble owns one `# Heading`-led section, so prompt bodies and other preambles can reference it by name. The composer's blank-line discipline keeps the system prompt readable even as the registry grows.

**Related:**
- [[wiki/specs/prompts-and-workflows]] — §"Runner"
- [[wiki/specs/cli]] — every workflow-driven CLI command (`lint`, `migrate`, `export-context`, and any future addition) inherits the preamble registry for free.
- [[wiki/gotchas/agent-prompt-regression]]
