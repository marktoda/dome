---
type: invariant
created: 2026-05-26
updated: 2026-05-26
sources: ["[[wiki/specs/prompts-and-workflows]]", "[[wiki/gotchas/agent-prompt-regression]]"]
tier: axiom
---

# WORKFLOWS_KNOW_VAULT_CONTEXT

**Tier:** Axiom — non-disable-able.

**Statement:** Every workflow's `system` parameter to `generateText` is prepended with a vault prologue that names `vault.path`. The LLM driving a workflow always knows which directory it is operating on, even when the workflow's user message is empty or carries only the task description.

**Why:** Workflow prompts are vault-shaped — they say things like "convert the directory," "walk the vault," "write the proposal to `.dome/migration-plan.md`." Tools are vault-bound at construction, but the LLM itself has no other channel to learn the vault's identity. Without the prologue, a self-driving workflow whose CLI command happened to pass an empty user message would have to guess (and would typically guess wrong, or stop and ask). This is exactly the failure that prompted the invariant: `dome migrate <path>` passed `""` as the user message, the migrate prompt referenced `<path>` as a literal placeholder with no plumbing behind it, and the LLM completed in one step by asking the user for the path the CLI had already supplied.

**Structural enforcement:** `runWorkflow` in `src/workflows/agent-loop.ts` constructs the `system` parameter as `${buildVaultPrologue(vault)}\n\n${def.body}`. There is no code path in `runWorkflow` that passes `def.body` to `generateText` without the prologue. The prologue function lives next to the runner so any future runner variant has the helper visibly available.

The separation is principled: **system prompt carries context** (which vault this is), **user message carries task** (what to do — and doubles as the commit subject via `subjectFromUserMessage`). CLI shims that drive workflows non-interactively are obligated to send a meaningful task description in the user message; they are NOT obligated to thread the vault path through it.

**Counter-example:** A new workflow `dome catalog` is added with a CLI shim that calls `runWorkflowAtPath(path, "catalog", "")`. The catalog prompt body says "Walk the vault root and enumerate top-level directories." Without the prologue, the LLM asks "which vault?" Violation. With the prologue, the LLM proceeds because the system prompt names the path.

Inverse counter-example: the migrate prompt's old form, `Convert the directory at <path> to a Dome vault.`, attempted to encode the context in the prompt body via a literal placeholder. There is no template substitution in `PromptLoader` — only `{{include: name.md}}` — so `<path>` was prose, not a variable. The prologue replaces this pattern: prompt bodies refer to "the current vault" and the path lives in the prologue.

**Test guarantee:**
- `tests/workflows/agent-loop.test.ts` — *"prepends a vault prologue naming vault.path to the system prompt"* uses a spying `MockLanguageModelV3` to capture `doGenerate` args and asserts `system` contains `vault.path`.
- `tests/cli/migrate-bootstrap.test.ts` — *"LLM receives vault.path in system prompt and a task description in the user message"* pins the boundary for the specific command whose absence motivated this invariant; an analogous assertion should be added to every future workflow-driven CLI command.

**Why an axiom (not configurable):**
- Vault identity is structural, not stylistic. There is no user-meaningful "disable the prologue" mode — disabling it just breaks workflows.
- The prologue is one paragraph of text. The cost of always including it is negligible against the cost of any caller forgetting it.
- Unlike `SENSITIVE_GOES_TO_INBOX` (a routing policy a project vault may not need) or `PAGE_CREATION_REQUIRES_RECURRENCE` (a discipline some users want and others don't), `WORKFLOWS_KNOW_VAULT_CONTEXT` is a contract between the runner and every prompt body. There is no defensible "off" position.

**Related:**
- [[wiki/specs/prompts-and-workflows]] — §"Runner"
- [[wiki/specs/cli]] — every workflow-driven CLI command (`lint`, `migrate`, `export-context`, and any future addition) inherits the prologue for free.
- [[wiki/gotchas/agent-prompt-regression]]
