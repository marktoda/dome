@AGENTS.md

## Claude Code

Use the Dome vault workflow in AGENTS.md. Edit markdown normally, commit
coherent changes with git, and use Dome commands when the user asks to wait for
adoption, explain compiler attention, resolve a Dome-raised decision, or render
an explicit source-backed vault view. For nontrivial vault work, read a
`dome export-context <topic> --json` packet or focused
`dome query <text> --json` result before broad manual file hunting.

The normal command path is `dome status --json` -> `next_actions` ->
`dome sync --json`, the suggested `dome check ...` command (often
`dome check --json`), `dome agent-work --json`, or `dome resolve <id> <value>`.
Complete `agent-safe` work only after reading every required source;
`model-safe` is the legacy equivalent. Surface `owner-needed` questions
instead of guessing.
