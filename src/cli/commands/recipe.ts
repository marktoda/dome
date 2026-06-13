// cli/commands/recipe: `dome recipe <kind>` — client setup recipes.
//
// v1 ships three recipes:
//   - `ios` — the iOS Shortcut that voice-captures into POST /capture (the
//     WS3-capture deliverable of the v1 plan), with the iCloud queue
//     fallback for an unreachable host.
//   - `capture-queue` — the laptop half of the queue fallback: the shipped
//     drain script + the launchd interval LaunchAgent that sweeps iCloud
//     Drive DomeCaptures/ into the vault. Deliberately a recipe, not a
//     dome.sources subscription (the manual dome-http unit precedent): the
//     subscription contract is one output file per period, a drain is many.
//   - `core-seed` — the owner interview prompt that seeds core.md's two
//     owner-authored sections in one foreground session (WS1 of the v1
//     plan: core.md activation).
// Recipes are plain text by design: they change when the surfaces they
// describe change, so they live next to the CLI rather than in docs that
// can drift.

import { join } from "node:path";

import { resolveShippedSourceHandlersRoot } from "../../extensions/bundle-roots";
import { EX_USAGE } from "../exit-codes";

export type RecipeOptions = {
  readonly kind: string;
  /** Base URL of the dome http server (default http://<your-server>:3663). */
  readonly url?: string | undefined;
};

export async function runRecipe(options: RecipeOptions): Promise<number> {
  if (options.kind === "ios") {
    let base = "http://<your-server>:3663";
    if (options.url !== undefined) {
      // Trailing-slash trim first, then validate: --url must parse as an
      // http(s) URL (the recipe interpolates it into POST targets and a
      // curl command — a typo here ships a broken Shortcut).
      const trimmed = options.url.replace(/\/+$/, "");
      if (!isHttpUrl(trimmed)) {
        console.error(
          `dome recipe: --url must be an http(s) URL like ` +
            `http://dome-server:3663 (got '${options.url}')`,
        );
        return EX_USAGE;
      }
      base = trimmed;
    }
    console.log(iosRecipe(base));
    return 0;
  }
  if (options.kind === "capture-queue") {
    console.log(captureQueueRecipe());
    return 0;
  }
  if (options.kind === "core-seed") {
    console.log(coreSeedRecipe());
    return 0;
  }
  console.error(
    `dome recipe: unknown recipe '${options.kind}' (available: ios, capture-queue, core-seed)`,
  );
  return EX_USAGE;
}

function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

function iosRecipe(base: string): string {
  return `dome recipe: iOS voice capture → ${base}/capture

Prerequisites
  1. The dome http surface is running on your server:
       DOME_HTTP_TOKEN=<token> dome http --vault <vault> --host <tailscale-ip>
     (bind a Tailscale interface, never a public one — see
      docs/wiki/specs/http-surface.md "Trust domain")
  2. Your phone is on the same Tailscale network.
  3. (Queue fallback) A "DomeCaptures" folder in iCloud Drive, drained on
     the laptop by \`dome recipe capture-queue\` — captures survive the
     host being asleep or unreachable.

Build the Shortcut (Shortcuts app → + → rename to "Dome Capture")
  1. Add action: "Dictate Text"
  2. Add action: "UUID"
  3. Add action: "Format Date"
       Date: Current Date, Date Format: Custom → yyyy-MM-dd-HHmmss
  4. Add action: "Text" → [Formatted Date]-[UUID]
     (the capture id — ONE string shared by the POST body and the queue
      filename, so a retry through either channel dedupes to one capture)
  5. Add action: "Save File"
       File: Dictated Text       Service: iCloud Drive
       Ask Where to Save: Off    Destination Path: DomeCaptures/[Text].md
     (queue first. Shortcuts has no try/catch: when "Get Contents of URL"
      hits an unreachable host it STOPS the shortcut — that stop is the
      failure branch, and the file saved here is what survives it. If
      "Save File" only offers the iCloud Drive/Shortcuts folder, create
      DomeCaptures inside it and point the drain there — see
      \`dome recipe capture-queue\` step 2.)
  6. Add action: "Get Contents of URL"
       URL:     ${base}/capture
       Method:  POST
       Headers: Authorization → Bearer <token>
       Request Body: JSON
         text      → Dictated Text   (the variable from step 1)
         captureId → Text            (the variable from step 4)
  7. Add action: "Delete Files" → File (from "Save File"),
       Confirm Before Deleting: Off
     (the POST landed, so the queue entry is cleared. If step 6 failed,
      the shortcut already stopped and the file waits in DomeCaptures/
      for the laptop-side drain — eventually consistent, never lost.)
  8. Add action: "Show Notification" → "Captured ✓"
  9. (Optional) Settings → Action Button → assign "Dome Capture".
     The same Shortcut works from the Apple Watch Shortcuts complication.

Verify from any shell on the Tailscale network
  curl -s -X POST ${base}/capture \\
    -H "Authorization: Bearer <token>" \\
    -H "content-type: application/json" \\
    -d '{"text":"recipe smoke test","captureId":"recipe-test-1"}'
  → {"status":"captured", ...}   (compile_pending until the daemon adopts)

The cockpit
  Open ${base}/today?token=<token> on any device in the trust domain for the
  self-refreshing today view (add it to the iPhone home screen via Safari →
  Share → Add to Home Screen).
`;
}

function captureQueueRecipe(): string {
  const shippedScript = join(
    resolveShippedSourceHandlersRoot(),
    "drain-captures.sh",
  );
  return `dome recipe: capture-queue — drain the iCloud capture queue into the vault

What this is
  The laptop half of eventually-consistent phone capture: when the iOS
  Shortcut (\`dome recipe ios\`) cannot reach POST /capture, it leaves the
  dictation as <timestamp>-<uuid>.md in iCloud Drive DomeCaptures/. This
  recipe installs the shipped drain script and a launchd LaunchAgent that
  sweeps the queue into the vault every 15 minutes (and on wake).

  Deliberately a recipe, not a dome.sources subscription: the subscription
  contract is one output file per period (skip-if-present, HEAD-verified —
  docs/wiki/specs/sources.md), and a drain is many files per run from a
  directory outside the vault. Manual unit, like the dome-http precedent.

1. Install the drain script (shipped with the SDK):

     mkdir -p <vault>/.dome/bin
     cp "${shippedScript}" \\
        <vault>/.dome/bin/drain-captures.sh
     chmod +x <vault>/.dome/bin/drain-captures.sh

2. Pick the queue directory — it must match where the Shortcut saves:
     iCloud Drive root (the default the script assumes):
       ~/Library/Mobile Documents/com~apple~CloudDocs/DomeCaptures
     If the Shortcut's "Save File" only writes under iCloud Drive/Shortcuts,
     create DomeCaptures there and use that path instead:
       ~/Library/Mobile Documents/iCloud~is~workflow~my~workflows/Documents/DomeCaptures
   Create the folder once (mkdir -p "<queue-dir>").

3. Save the LaunchAgent at
   ~/Library/LaunchAgents/com.dome.drain-captures.plist — fill in <vault>,
   <queue-dir>, and <dome-bin-dir> (= dirname "$(command -v dome)"):

     <?xml version="1.0" encoding="UTF-8"?>
     <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
     <plist version="1.0">
     <dict>
       <key>Label</key><string>com.dome.drain-captures</string>
       <key>ProgramArguments</key>
       <array>
         <string>/bin/sh</string>
         <string><vault>/.dome/bin/drain-captures.sh</string>
         <string><queue-dir></string>
       </array>
       <key>WorkingDirectory</key><string><vault></string>
       <key>EnvironmentVariables</key>
       <dict>
         <key>PATH</key><string><dome-bin-dir>:/usr/local/bin:/usr/bin:/bin</string>
       </dict>
       <key>StartInterval</key><integer>900</integer>
       <key>RunAtLoad</key><true/>
       <key>StandardOutPath</key><string>/tmp/dome-drain-captures.log</string>
       <key>StandardErrorPath</key><string>/tmp/dome-drain-captures.log</string>
     </dict>
     </plist>

   (WorkingDirectory = the vault root is how \`dome capture\` finds the
    vault; StartInterval 900 matches the 15-minute sources cadence, and
    launchd coalesces missed intervals into one run on wake.)

4. Load it:

     launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dome.drain-captures.plist

   (After edits: launchctl bootout gui/$(id -u)/com.dome.drain-captures,
    then bootstrap again. Status: launchctl print gui/$(id -u)/com.dome.drain-captures)

5. Smoke test without waiting for the interval:

     printf 'queue smoke test\\n' > "<queue-dir>/$(date +%Y-%m-%d-%H%M%S)-smoke.md"
     cd <vault> && sh .dome/bin/drain-captures.sh "<queue-dir>"

   → one new inbox/raw/ capture, committed; the queue file is gone.
     Re-creating the same filename and re-running answers "duplicate" and
     clears it again (captureId = the filename stem, so a crash between
     capture and delete never double-files).

Semantics
  - Each *.md queue file becomes one \`dome capture\` (file body = capture
    body, captureId = filename stem); success deletes the queue file.
  - Failure (vault busy, dome not on PATH) keeps the file; the next
    interval retries. Empty queue → exit 0, silent.
  - Not-yet-downloaded iCloud placeholders (.<name>.md.icloud) get a
    best-effort \`brctl download\` and are picked up on a later interval.
`;
}

function coreSeedRecipe(): string {
  return `dome recipe: core-seed — seed core.md, the always-loaded core memory page

core.md has three sections:
  ## Who I am              — owner-authored: role, team, context
  ## Active projects       — generated by Dome from open loops; do not hand-author
  ## Standing preferences  — owner-authored rules + a Dome-managed promoted block

Seed it in one foreground session: open your vault in Claude Code (or any
agent harness) and paste the prompt below. Review the draft, edit it until
it sounds like you, and commit.

--- paste below this line ---

Interview me to seed core.md, my always-loaded core memory page. Ask one
question at a time:

  1. Who am I? My role, what I'm responsible for, the context an agent
     should always have.
  2. Who is on my team / who do I work with most, and on what?
  3. What standing preferences should agents always honor — formatting,
     filing, naming, scope, tone?
  4. What am I currently focused on? (context for the draft only)

Then draft ONLY the "## Who I am" and "## Standing preferences" sections of
core.md and show them to me for my edit and approval before writing the
file. Rules:

  - Keep the whole page under the 6,000-character budget: always-relevant
    summary here, details in wiki pages.
  - NEVER write inside marker-delimited blocks (HTML-comment markers);
    they are Dome-managed — leave the markers and their contents alone.
  - "## Active projects" is generated by Dome — do not hand-author it;
    leave the heading empty.

--- paste above this line ---
`;
}
