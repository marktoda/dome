// platform/launchd: the small macOS LaunchAgent Adapter shared by legacy Serve
// lifecycle commands and the Dome Home product lifecycle.

import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { open, rename, rm, type FileHandle } from "node:fs/promises";

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

export type PlistPublicationDeps = {
  readonly openTemporary?: ((path: string) => Promise<Pick<FileHandle, "writeFile" | "sync" | "close">>) | undefined;
  readonly renamePath?: ((source: string, target: string) => Promise<void>) | undefined;
  readonly syncParent?: ((path: string) => Promise<void>) | undefined;
  readonly removeTemporary?: ((path: string) => Promise<void>) | undefined;
};

/** Publish complete, durable private plist bytes before launchd can see them. */
export async function publishLaunchAgentPlist(
  plistPath: string,
  contents: string,
  deps: PlistPublicationDeps = {},
): Promise<void> {
  const temporary = `${plistPath}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Pick<FileHandle, "writeFile" | "sync" | "close"> | null = null;
  try {
    handle = await (deps.openTemporary ?? openPrivateTemporary)(temporary);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await (deps.renamePath ?? rename)(temporary, plistPath);
    await (deps.syncParent ?? syncDirectory)(dirname(plistPath));
  } finally {
    if (handle !== null) await handle.close().catch(() => {});
    await (deps.removeTemporary ?? removeTemporary)(temporary);
  }
}

async function openPrivateTemporary(path: string): Promise<FileHandle> {
  return open(path, "wx", 0o600);
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

async function removeTemporary(path: string): Promise<void> {
  await rm(path, { force: true });
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

/** Home-only strict probe: launchd's exact absent result is 113. */
export async function probeLaunchAgentLoadedStrict(input: {
  readonly launchctl: LaunchctlRunner;
  readonly target: string;
}): Promise<boolean> {
  const probe = await input.launchctl(["print", input.target]);
  if (probe.exitCode === 0) return true;
  if (probe.exitCode === 113) return false;
  throw new Error(`launchctl print ${input.target} failed: ${launchctlDetail(probe)}`);
}

/** Home-only drain that never interprets an ambiguous launchd failure as stopped. */
export async function waitForLaunchAgentDrainStrict(input: {
  readonly launchctl: LaunchctlRunner;
  readonly target: string;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    if (!await probeLaunchAgentLoadedStrict(input)) return true;
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
