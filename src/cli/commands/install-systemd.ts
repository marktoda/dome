// cli/commands/install-systemd: the Linux (systemd --user) backend for
// `dome install` / `dome uninstall` / `dome restart`.
//
// Mirrors the launchd backend in install.ts behind the same ServiceDeps
// boundary: a deterministic per-vault unit name, idempotent install
// (write unit → daemon-reload → enable → restart), uninstall that is a
// clean no-op when nothing is installed, restart-from-existing-unit.
// The unit runs in the user manager (`systemctl --user`); surviving
// logout/boot additionally needs `loginctl enable-linger <user>` — an ops
// step documented in the migration runbook, deliberately not automated
// (it requires root on some distros).

import { servicePath } from "./install";

// ----- Unit rendering (pure, exported for tests) -----------------------------

/**
 * Render the systemd user unit for `dome serve`. Restart=always mirrors
 * launchd KeepAlive; append: log redirection mirrors the plist's
 * StandardOutPath/StandardErrorPath; Environment carries PATH (user
 * managers get a minimal PATH that cannot resolve ~/.bun) plus
 * caller-supplied entries.
 */
export function renderServeSystemdUnit(input: {
  readonly bunPath: string;
  readonly domeBin: string;
  readonly vaultPath: string;
  readonly logPath: string;
  readonly environment?: ReadonlyMap<string, string>;
}): string {
  // Quoting convention: path-bearing args quoted (systemd's quoted-word
  // syntax), plain verbs/flags (`serve`, `--vault`) bare.
  const quote = (arg: string): string => `"${execEscape(arg)}"`;
  const exec = `${quote(input.bunPath)} ${quote(input.domeBin)} serve --vault ${
    quote(input.vaultPath)
  }`;
  const environment = new Map<string, string>([
    ["PATH", servicePath(input.bunPath)],
    ...(input.environment ?? []),
  ]);
  const envLines = [...environment]
    .map(([key, value]) => `Environment="${key}=${envEscape(value)}"`)
    .join("\n");
  return `[Unit]
Description=Dome compiler host (dome serve) for ${input.vaultPath}
After=network.target

[Service]
ExecStart=${exec}
WorkingDirectory=${input.vaultPath}
${envLines}
Restart=always
RestartSec=2
StandardOutput=append:${input.logPath}
StandardError=append:${input.logPath}

[Install]
WantedBy=default.target
`;
}

/** Escape a value for inside Environment="KEY=...": %, ", \. */
function envEscape(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

/** Escape an ExecStart quoted argument: " and \ only. */
function execEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
