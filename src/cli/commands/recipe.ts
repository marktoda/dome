// cli/commands/recipe: `dome recipe <kind>` — client setup recipes.
//
// v1 ships one recipe: `ios` — the iOS Shortcut that voice-captures into
// POST /capture (the WS3-capture deliverable of the v1 plan). The recipe is
// plain text by design: it changes when the HTTP surface changes, so it
// lives next to the CLI rather than in a doc that can drift.

import { EX_USAGE } from "../exit-codes";

export type RecipeOptions = {
  readonly kind: string;
  /** Base URL of the dome http server (default http://<your-server>:3663). */
  readonly url?: string | undefined;
};

export async function runRecipe(options: RecipeOptions): Promise<number> {
  if (options.kind !== "ios") {
    console.error(
      `dome recipe: unknown recipe '${options.kind}' (available: ios)`,
    );
    return EX_USAGE;
  }
  const base = (options.url ?? "http://<your-server>:3663").replace(/\/+$/, "");
  console.log(iosRecipe(base));
  return 0;
}

function iosRecipe(base: string): string {
  return `dome recipe: iOS voice capture → ${base}/capture

Prerequisites
  1. The dome http surface is running on your server:
       DOME_HTTP_TOKEN=<token> dome http --vault <vault> --host 0.0.0.0
     (bind a Tailscale interface, never a public one — see
      docs/wiki/specs/http-surface.md "Trust domain")
  2. Your phone is on the same Tailscale network.

Build the Shortcut (Shortcuts app → + → rename to "Dome Capture")
  1. Add action: "Dictate Text"
  2. Add action: "Get Contents of URL"
       URL:     ${base}/capture
       Method:  POST
       Headers: Authorization → Bearer <token>
       Request Body: JSON
         text      → Dictated Text   (the variable from step 1)
         captureId → Shortcut Input? No — add a "UUID" action before this
                     step and bind captureId → UUID (makes retries idempotent)
  3. Add action: "Show Notification" → "Captured ✓"
  4. (Optional) Settings → Action Button → assign "Dome Capture".
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
