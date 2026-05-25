---
type: gotcha
created: 2026-05-25
updated: 2026-05-25
severity: low
first_observed: 2026-05-25
sources: ["[[cohesive/brainstorms/2026-05-25-dome-vision]]"]
---

# Out-of-band vault edits

**Symptom:** The user edits a wiki page in Obsidian. The next Dome `writeDocument` to that page references stale data, or the page now violates an invariant (e.g., the user added a short-form wikilink that breaks `WIKILINKS_ARE_FULLPATH`). The index doesn't reflect the user's edit until something rebuilds it.

**Root cause:** Markdown is the source of truth (`MARKDOWN_IS_SOURCE_OF_TRUTH`). The user is welcome to edit anywhere — Obsidian, vim, GitHub web editor, anywhere. Dome's Tools are not the only mutation path; they're the only *Dome-managed* mutation path. Out-of-band edits are *expected*, not an error.

**Structural response (not a "mitigation" because it's not a bug):**

- The filesystem watcher (started by `dome serve`) detects out-of-band writes and emits `vault.out-of-band-edit` events. Hooks observing this event can invalidate caches, sync to remote, alert, etc.
- `dome doctor` reads the markdown directly and reports any invariant violations introduced by out-of-band edits (short-form wikilinks, missing index entries, type/directory mismatches, frontmatter schema drift).
- The next Dome `writeDocument` to a page that has out-of-band edits will fail if those edits introduced an invariant violation. The user sees the error, runs `dome doctor` to identify the violation, fixes it (in Obsidian or via Dome), then retries.

**Why this is design, not a bug:**

The first-class equality of "Dome-managed" and "user-managed" edits is what makes the vault portable. If Dome refused to tolerate out-of-band edits, the user couldn't use Obsidian, couldn't grep, couldn't write a custom script. The "Dome works alongside your existing tools" promise breaks. Better: tolerate out-of-band edits, surface drift via `dome doctor`, let the user resolve at their pace.

**User-facing expectations:**

- "I edited a page in Obsidian and Dome is now confused" → run `dome doctor`; it lists violations; fix them.
- "I want Dome to track every edit including manual ones" → `dome serve` keeps the filesystem watcher running; `vault.out-of-band-edit` events are logged.
- "I want Dome to refuse out-of-band edits" → not supported. The vault is yours. Use git pre-commit hooks if you want enforcement at edit time, not at Dome-tool time.

**Obsidian configuration recommendation:**

Set Obsidian's "Default link format" to **"Absolute path in vault"** in Preferences → Files & Links. This makes Obsidian's auto-completed wikilinks compatible with `WIKILINKS_ARE_FULLPATH`. With this setting, out-of-band Obsidian edits are unlikely to introduce wikilink violations.

**Plugin / sync-layer notes:**

Sync layers (Syncthing, git, iCloud Drive) generate out-of-band edits when receiving changes from other devices. The watcher treats them the same as user edits. `dome doctor` reports drift; the user resolves. In v1+, a more sophisticated sync model may register itself as a "trusted mutator" that bypasses the out-of-band-edit event, but that's a v1+ decision.

**Related:**
- [[wiki/invariants/MARKDOWN_IS_SOURCE_OF_TRUTH]]
- [[wiki/specs/harnesses]] §"What's NOT a harness"
- [[wiki/specs/cli]] §"`dome doctor`"
- [[wiki/entities/obsidian]] §"Recommended settings"
