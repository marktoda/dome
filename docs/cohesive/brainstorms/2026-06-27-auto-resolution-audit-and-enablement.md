# Auto-resolution Phase-3: the answered_by audit trail + enablement

**Date:** 2026-06-27
**Status:** design, approved direction (recommended options taken; Mark AFK — all three choices are reversible config/copy) — ready for implementation plan
**Scope:** `answers.db` schema + its writers/readers; `default-vault-config.ts`; the auto-resolution pump's actor stamp.
**Continues:** [[2026-06-26-questions-as-decisions-recategorize-integrity]] and [[2026-06-27-sweep-escalations-as-diagnostics]] — with the question queue reduced to genuinely actionable decisions, the parked Phase-3 ("a background loop answers grounded agent-safe questions so they never reach the owner") becomes safe to enable.

## Why now, and why the audit trail first

The auto-resolution machinery (`src/engine/operational/question-auto-resolution.ts`)
already exists and is conservative: it answers only questions whose
`automationPolicy` is in the config allowlist AND `risk === "low"` AND
`confidence >= min_confidence` AND a non-empty `recommendedAnswer` that is in
the question's `options` (when constrained) AND whose sourceRefs all exist in
the adopted snapshot — capped at `max_per_tick` per operational tick. It
records the answer durably and dispatches answer handlers identically to a
human `dome resolve`.

The one missing guardrail both explorations flagged: **no audit trail**.
`question_answers` has no actor field, so an auto-answer is indistinguishable
from a human one. Enabling autonomy without observability is how silent wrong
answers become trust damage. So Part 1 is the field; Part 2 is the switch.

## Part 1 — `answered_by`

### Schema + migration

`answers.db` `question_answers` gains:

```sql
answered_by TEXT NOT NULL DEFAULT 'owner'
```

Values: `'owner'` (CLI/MCP `dome resolve` / `dome answer`) and `'auto'` (the
auto-resolution pump). The default backfills existing rows as `'owner'`, which
is historically accurate (auto-resolution has never run).

`answers.db` is durable and unrebuildable, and its open policy is
`{kind: "refuse"}` on schema-hash mismatch — so this change REQUIRES switching
to `{kind: "migrate"}` with a `tryMigrate(db, storedHash)` that, when
`storedHash` equals the prior schema hash, runs the `ALTER TABLE
question_answers ADD COLUMN` and returns true. This is the exact precedent the
outbox store already ships (`src/outbox/db.ts:264` under
`src/sqlite/open-store.ts`'s migrate policy). Any other stored hash still
refuses (unknown future/corrupt schema).

### Writers

- `recordQuestionAnswer` (src/answers/question-answers.ts) and
  `answerQuestionDurably` (question-answer-recording.ts) take a required
  `answeredBy: "owner" | "auto"`.
- `vault.resolve` (the CLI/MCP path) passes `'owner'`.
- `runQuestionAutoResolution` passes `'auto'`.

### Readers / surfacing (quiet, not nagging)

- The projection `questions` table carries `answered_by` alongside
  `answered_at`/`answer` (projection is rebuildable — plain DDL change, no
  migration pain), populated on answer and on rehydration from `answers.db`.
- `dome resolve <id>` / `dome answer <id>` display mode shows the actor for an
  already-answered question ("answered by auto …").
- `dome inspect questions --json` includes the field.
- Deliberately NO per-auto-answer diagnostic: auto-answers are the system
  working as intended; they are auditable on inspection, not attention. (If
  volume or wrong answers ever argue otherwise, an info diagnostic is a
  one-line follow-up.)

## Part 2 — enablement

- **Engine built-in default stays OFF** (`DEFAULT_RUNTIME_CONFIG.engine.
  autoResolveQuestions.enabled: false`). Existing vaults change nothing on
  upgrade.
- **The shipped vault-config template turns it on explicitly**:
  `src/cli/default-vault-config.ts`'s commented `auto_resolve_questions` block
  becomes a live block —

  ```yaml
  auto_resolve_questions:
    enabled: true
    policies:
      - "agent-safe"
    min_confidence: 0.6
    max_per_tick: 20
  ```

  New vaults (`dome init`) get auto-resolution ON, visibly, in their own
  config file where it's one line to disable.
- **Work vault (dogfood):** enabled post-merge by adding the same block to
  `~/vaults/work/.dome/config.yaml`, bundled with the already-pending daemon
  restart. Operational step, not part of the SDK diff.

### What actually auto-resolves at launch

With `policies: ["agent-safe"]` and floor 0.6, exactly two current emitters
qualify:

- `dome.health.orphan-run-recovery-questions` — "mark stuck run failed?"
  (risk low, confidence 1.0, recommendedAnswer `fail`). The canonical case.
- `dome.daily.task-index` ambiguous-followups — "track this as a follow-up?"
  (risk low, confidence 0.65, recommendedAnswer `track`). Accepted: a false
  positive becomes a visible, trimmable task — low harm, and it feeds the
  task lifecycle that already has settlement machinery.

Blocked by their own metadata, unchanged and documented as known quirks, NOT
"fixed" here:

- `dome.agent.brief` failure question — agent-safe but carries no
  risk/confidence, so it never passes the gates. (Arguably diagnostic-shaped;
  a candidate for a later reframe pass, out of scope.)
- `dome.markdown.validate-wikilinks` — risk medium + no recommendedAnswer;
  correctly stays human.

## Out of scope

- The `model-safe` tier (the code path treats it identically today — no model
  call; enabling it is a separate decision after `agent-safe` earns trust).
- Per-processor/per-key disable knobs, dry-run/shadow mode.
- Reclassifying the brief failure question.
- Any change to the auto-resolution gates themselves.

## Testing

- **Migration:** build an answers.db at the OLD schema (prior DDL, prior
  hash), reopen through `openAnswersDb` → expect `migration: "migrated"`,
  existing rows preserved with `answered_by = 'owner'`, new schema hash
  recorded. A wrong/unknown stored hash still refuses.
- **Actor stamping:** human `vault.resolve` → row has `'owner'`;
  `runQuestionAutoResolution` answering a qualifying question → `'auto'`,
  and handlers dispatch as before.
- **Surfacing:** `inspect questions --json` and the `dome resolve <id>`
  display include the actor.
- **Config:** `dome init`'s generated config parses with
  `auto_resolve_questions.enabled: true`; `DEFAULT_RUNTIME_CONFIG` still
  defaults OFF; existing gate tests unchanged.

## Acceptance criteria

1. `answered_by` is durable, migrated in place on existing vaults (no data
   loss, refuse only on unknown hashes), stamped `'owner'`/`'auto'` correctly,
   and visible in resolve display + inspect.
2. New vaults ship with auto-resolution enabled in their config; the engine
   default remains OFF; existing vaults are unaffected until they opt in.
3. On the work vault (post-merge, post-restart): stuck orphan runs and
   ambiguous follow-ups stop appearing as open questions and show up as
   auto-answered rows with `answered_by = 'auto'`.
