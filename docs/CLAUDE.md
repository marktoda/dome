@AGENTS.md

## Claude Code

Use the Dome vault workflow in AGENTS.md. Edit markdown normally, commit
coherent changes with git, and use Dome commands when the user asks to wait for
adoption, explain compiler attention, resolve a Dome-raised decision, or render
an explicit source-backed vault view. The normal command path is
`dome status --json` -> `next_actions` -> `dome sync --json`,
the suggested `dome check ...` command (often `dome check --json`), or
`dome resolve <id> <value>`.
