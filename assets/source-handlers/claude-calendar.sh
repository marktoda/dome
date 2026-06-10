#!/bin/sh
# claude-calendar.sh — dome.sources fetch-command template (calendar kind).
#
# This file is SDK-shipped vault-side data, not SDK code (the model-provider
# template precedent: nothing under src/ executes it). Copy it into your
# vault — conventionally `.dome/bin/fetch-calendar.sh` — adjust the FETCH
# section, and name it in the subscription:
#
#   extensions:
#     dome.sources:
#       config:
#         subscriptions:
#           calendar:
#             enabled: true
#             schedule: "10 5 * * *"
#             output_path: "sources/calendar/{date}.md"
#             command: ["sh", ".dome/bin/fetch-calendar.sh"]
#
# Contract with the dome.sources handler (wiki/specs/sources.md):
#   - Invoked from the VAULT ROOT as: <command...> <date> <output_path>
#     ($1 = YYYY-MM-DD, $2 = vault-relative output path).
#   - Fetch the agenda, write $2 in the calendar-day shape
#     (wiki/specs/vault-layout.md §"sources/"), and COMMIT it as an
#     ordinary git commit (a non-engine commit the daemon adopts).
#   - Exit non-zero on ANY failure so the outbox records the attempt and
#     retries; never commit a partial or empty-because-broken file.
#   - The attempt is bounded by engine.external_handler_timeout_ms
#     (default 30s). A headless-model fetch like the default below needs
#     that raised in .dome/config.yaml (e.g. 300000).

set -eu

d="$1"
f="$2"

mkdir -p "$(dirname "$f")"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

# ----- FETCH (adjust to taste) ----------------------------------------------
# Default: headless Claude with calendar access (MCP or gcalcli underneath).
# Swap this block for a direct `gcalcli agenda ... | awk ...` pipeline or an
# EventKit script if you prefer a deterministic fetcher — anything that
# emits the calendar-day markdown shape on stdout works.
claude -p --output-format text "Print today's ($d) calendar agenda as a Dome \
calendar-day markdown file and NOTHING else. Exact shape: a YAML frontmatter \
block with 'type: calendar-day' and 'date: $d', then '# Calendar $d', then \
one '- ' list item per meeting: optional HH:MM–HH:MM time, ' — ', the title, \
and optional ' (attendees: a, b)'. If there are no meetings, emit the \
frontmatter and heading only." > "$tmp"

# ----- VALIDATE ---------------------------------------------------------------
# Refuse to commit something that is not a calendar-day file (a model
# refusal, an error page, an empty fetch).
head -n 1 "$tmp" | grep -q '^---$' || {
  echo "fetch-calendar: output is not a calendar-day file (no frontmatter)" >&2
  exit 1
}
grep -q "^date: $d$" "$tmp" || {
  echo "fetch-calendar: output frontmatter does not carry date: $d" >&2
  exit 1
}

# ----- LAND (ordinary non-engine commit; the daemon adopts it) ----------------
mv "$tmp" "$f"
trap - EXIT
git add "$f"
git commit -m "calendar: agenda for $d"
