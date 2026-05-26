---
type: invariant
created: 2026-05-26
updated: 2026-05-26
sources: ["[[wiki/specs/prompts-and-workflows]]", "[[wiki/gotchas/agent-prompt-regression]]"]
tier: axiom
---

# WORKFLOWS_KNOW_VAULT_CONTEXT

**Tier:** Axiom — non-disable-able.

**Statement:** Every workflow's `system` parameter to `generateText` carries the situational context the LLM needs to operate on the right vault and render to the right surface. The context is split across two SDK partials at different inclusion sites:

- **`preamble-vault-identity.md`** — included at the top of `system-base.md`. Names `vault.path` (via the `{{vault.path}}` template variable substituted by `PromptLoader`) so prompt bodies that say "the vault" or "the directory" have an anchor. **Scope:** every surface that loads system-base — workflow runs AND MCP-side surfaces (`buildInstructions`, `dome.system_prompt`). Vault identity is universally needed.
- **`preamble-rendering-surface.md`** — included by each shipped workflow prompt directly (after its `{{include: system-base.md}}` line), **not** by `system-base.md`. Tells the LLM its reply is the workflow's final terminal output (or, for hook-driven runs, is discarded), that there is no conversational follow-up channel, and that next-step guidance should name the next CLI command rather than address a chat shell that does not exist. **Scope:** workflow runs only. Placing this in system-base would leak workflow-only framing into MCP `instructions` (delivered to interactive Claude Code sessions), telling an interactive client it has "no conversational follow-up channel" — actively wrong.

Both partials are part of the **vault augmentation slot model** (see [[wiki/specs/prompts-and-workflows]] §"Vault augmentation slots"). Vault-local overrides at `.dome/prompts/preamble-vault-identity.md` or `.dome/prompts/preamble-rendering-surface.md` replace the SDK defaults if a vault has good reason to reshape the situational framing; absence means the SDK defaults apply. Additional situational context (today's date, recent activity hints, vault-config-aware behavior, etc.) is added by writing a new SDK partial — included from `system-base.md` if universal, or from each workflow prompt if workflow-only — or by a vault filling one of the augmentation slots (`vault-prologue.md`, `<workflow-name>-augment.md`, `<workflow-name>-epilogue.md`).

**Why:** Workflow prompts are vault-shaped and surface-blind — they say things like "convert the directory," "walk the vault," "write the proposal to `.dome/migration-plan.md`." Tools are vault-bound at construction, but the LLM itself has no other channel to learn the vault's identity or the rendering surface its reply will appear on. Without preambles:

- The vault path is unknown — `dome migrate <path>` passed `""` as the user message, the migrate prompt referenced `<path>` as a literal placeholder with no plumbing behind it, and the LLM completed in one step by asking the user for the path the CLI had already supplied.
- The rendering surface is unknown — workflow output ends up shaped like chat prose ("say apply the plan", "if you want to, answer those questions") even though it's rendered into a terminal that has no reply channel.

Both failures share a single substrate gap: **the LLM driving a workflow needs to know what situation it's in**, and the runner is the only place that knows.

**Structural enforcement:** `runWorkflow` constructs the `system` parameter as `def.body` — the workflow body resolved through `PromptLoader`, which (a) inlines `{{include: ...}}` partials including the two preambles at the top of `system-base.md`, and (b) substitutes `{{vault.path}}` with the actual vault path. There is no code path in `runWorkflow` that passes a system prompt to `generateText` without going through `def.body`, and there is no code path that loads a workflow prompt without going through `PromptLoader`. The structural seam is at the prompt-loader boundary, not the runner boundary.

The separation is principled: **preambles describe the situation** (which vault, which surface, what date), **the workflow body describes the task**, **the user message carries the specific instruction** (and doubles as the commit subject via `subjectFromUserMessage`). CLI shims that drive workflows non-interactively are obligated to send a meaningful task description in the user message; they are NOT obligated to thread vault path or rendering hints through it.

**Counter-example:** A new workflow `dome catalog` is added with a CLI shim that calls `runWorkflowAtPath(path, "catalog", "")`. The catalog prompt body says "Walk the vault root and enumerate top-level directories." Without the preambles, the LLM asks "which vault?" *and* assumes a conversational reply channel ("Want me to filter by category?"). With the preambles, the LLM proceeds against the named vault and produces a terminal-shaped summary that names the next CLI command rather than asking follow-ups.

Inverse counter-example: the migrate prompt's old form, `Convert the directory at <path> to a Dome vault.`, attempted to encode the context in the prompt body via a literal placeholder. `<path>` was prose, not a recognized template variable, so it was passed through unsubstituted. The current model recognizes only the explicit `{{vault.path}}` syntax (a closed set defined in `PromptLoader.substituteVariables`); `<path>` is structurally distinct and won't be mistaken for substitution. The substrate scar that motivated the original preamble registry is preserved by **bounding the substitution surface explicitly**, not by avoiding substitution entirely.

**Test guarantee:**
- `tests/workflows/agent-loop.test.ts` —
  - *"prepends a vault-identity preamble naming vault.path to the system prompt"* asserts `system` contains `vault.path` after `runWorkflow` runs against a `MockLanguageModelV3` spy.
  - *"prepends a rendering-surface preamble describing non-interactive single-turn semantics"* asserts the surface preamble's stable phrasing ("non-interactive", "CLI") appears in the captured system prompt.
  - *"system-base.md includes vault-identity (universal) but NOT rendering-surface (workflow-only)"* pins the split: vault-identity is in system-base; rendering-surface is not.
  - *"resolved workflow body carries the rendering-surface preamble (via per-workflow include)"* pins the corollary: per-workflow inclusion delivers rendering-surface to workflow runs.
- `tests/prompts/extension-points.test.ts` —
  - *"every shipped workflow prompt includes the rendering-surface preamble — workflow runs only"* pins the structural placement at each workflow file.
  - *"resolved workflow body composes slots in the documented order"* pins the load-bearing composition order — vault-identity → system-base → vault-prologue → rendering-surface → workflow body → augment → epilogue.
  - *"vault-local override of an SDK-shipped preamble wins"* pins that SDK preambles participate in the override mechanism, so vaults can reshape framing without forking the SDK.
  - *"{{vault.path}} template substitution"* pins the closed substitution surface: only `{{vault.path}}` is recognized; unknown variables like `{{vault.today}}` are left intact (for `dome doctor` or reviewers to catch).
- `tests/mcp/instructions-builder.test.ts` — *"does NOT carry the workflow-only rendering-surface preamble (interactive context)"* pins the negative side of the split: MCP `instructions` (delivered to interactive Claude Code sessions) does not carry non-interactive framing.
- `tests/mcp/prompt-adapters.test.ts` — *"dome.system_prompt carries vault-identity but NOT the workflow-only rendering-surface"* and *"dome.workflow.* prompts DO carry the rendering-surface preamble"* together pin both directions of the split at the MCP prompt-adapter boundary.
- `tests/cli/migrate-bootstrap.test.ts` — *"LLM receives vault.path in system prompt and a task description in the user message"* pins the end-to-end boundary for the specific command whose absence motivated this invariant; an analogous assertion should be added to every future workflow-driven CLI command.

**Why an axiom (not configurable):**
- Situational context is structural, not stylistic. There is no user-meaningful "disable the preambles" mode — disabling them just breaks workflows.
- The preambles are short and uniform across vaults. The cost of always including them is negligible against the cost of any caller forgetting them.
- Unlike `SENSITIVE_GOES_TO_INBOX` (a routing policy a project vault may not need) or `PAGE_CREATION_REQUIRES_RECURRENCE` (a discipline some users want and others don't), `WORKFLOWS_KNOW_VAULT_CONTEXT` is a contract between the runner and every prompt body. There is no defensible "off" position.

**Extension model:** Future situational context the LLM should always know (today's date for time-sensitive workflows, currently-enabled invariant set for vault-config-aware behavior, recent activity hints to bias toward continuity, etc.) lands as a new SDK partial in `src/prompts/builtin/preamble-<name>.md` plus a corresponding `{{include: preamble-<name>.md}}` line in `system-base.md`. If the partial needs to interpolate runtime state, the variable joins the closed set in `PromptLoader.substituteVariables` (currently just `{{vault.path}}`); adding a new variable is a deliberate substrate change, not an ad-hoc extension.

Each preamble owns one `# Heading`-led section, so prompt bodies and other preambles can reference it by name. The blank-line discipline in `system-base.md` keeps the system prompt readable even as the preamble set grows. Vault-local overrides (`<vault>/.dome/prompts/preamble-<name>.md`) replace SDK preambles for vaults that need different framing.

**Related:**
- [[wiki/specs/prompts-and-workflows]] — §"Runner"
- [[wiki/specs/cli]] — every workflow-driven CLI command (`lint`, `migrate`, `export-context`, and any future addition) inherits the preamble registry for free.
- [[wiki/gotchas/agent-prompt-regression]]
