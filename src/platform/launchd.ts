// platform/launchd: the small macOS LaunchAgent Adapter shared by legacy Serve
// lifecycle commands and the Dome Home product lifecycle.

import { randomUUID } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

export type LaunchctlResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type LaunchctlRunner = (
  args: ReadonlyArray<string>,
) => Promise<LaunchctlResult>;

export function renderLaunchAgentPlist(input: {
  readonly label: string;
  readonly programArguments: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly logPath: string;
  readonly environment: ReadonlyMap<string, string>;
}): string {
  const argXml = input.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const envXml = [...input.environment]
    .map(([key, value]) =>
      `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.workingDirectory)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`;
}

/** Publish a complete plist atomically so launchd never observes partial XML. */
export async function publishLaunchAgentPlist(
  plistPath: string,
  contents: string,
): Promise<void> {
  const temporary = `${plistPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, plistPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function activateLaunchAgent(input: {
  readonly launchctl: LaunchctlRunner;
  readonly uid: number;
  readonly label: string;
  readonly plistPath: string;
}): Promise<string | null> {
  const bootstrap = await input.launchctl([
    "bootstrap",
    `gui/${input.uid}`,
    input.plistPath,
  ]);
  if (bootstrap.exitCode !== 0) {
    return `launchctl bootstrap gui/${input.uid} failed: ${launchctlDetail(bootstrap)} (plist left at ${input.plistPath})`;
  }
  const target = `gui/${input.uid}/${input.label}`;
  const kickstart = await input.launchctl(["kickstart", "-k", target]);
  if (kickstart.exitCode !== 0) {
    return `launchctl kickstart -k ${target} failed: ${launchctlDetail(kickstart)} (plist left at ${input.plistPath})`;
  }
  return null;
}

export async function waitForLaunchAgentDrain(input: {
  readonly launchctl: LaunchctlRunner;
  readonly uid: number;
  readonly label: string;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    const probe = await input.launchctl([
      "print",
      `gui/${input.uid}/${input.label}`,
    ]);
    if (probe.exitCode !== 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function launchctlDetail(result: LaunchctlResult): string {
  return result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
