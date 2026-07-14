// product-host/home-credentials: the complete macOS Keychain seam for Dome
// Home provider credentials. Callers can observe presence or lend a secret to
// one callback; secret bytes are never returned, persisted, or passed in argv.

import { homedir } from "node:os";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const SECURITY = "/usr/bin/security";
export const HOME_CREDENTIAL_SERVICE = "com.dome.home.credentials.v1" as const;
export const HOME_CREDENTIAL_SLOTS = Object.freeze([
  "model.anthropic.api-key",
  "transcription.api-key",
] as const);

export type HomeCredentialSlot = typeof HOME_CREDENTIAL_SLOTS[number];
export type HomeCredentialErrorCode =
  | "unsupported-platform"
  | "missing"
  | "locked"
  | "denied"
  | "failed"
  | "consumer-failed";

export class HomeCredentialError extends Error {
  readonly code: HomeCredentialErrorCode;

  constructor(code: HomeCredentialErrorCode, message: string) {
    super(message);
    this.name = "HomeCredentialError";
    this.code = code;
  }
}

export class HomeCredentialMigrationRequiredError extends Error {
  readonly code = "credential-migration-required" as const;

  constructor() {
    super("Dome Home environment cannot persist secret-like variables; store provider credentials in macOS Keychain");
    this.name = "HomeCredentialMigrationRequiredError";
  }
}

export type HomeCredentialInspection = Readonly<{ present: boolean }>;
export type HomeCredentialRemoval = Readonly<{ removed: boolean }>;

export type HomeCredentials = Readonly<{
  inspect(vaultPath: string, slot: HomeCredentialSlot): Promise<HomeCredentialInspection>;
  withSecret(vaultPath: string, slot: HomeCredentialSlot, consume: (secret: string) => Promise<unknown>): Promise<void>;
  remove(vaultPath: string, slot: HomeCredentialSlot): Promise<HomeCredentialRemoval>;
}>;

export type HomeCredentialCommand = Readonly<{
  stdin: "ignore";
  stdout: "capture" | "ignore";
  stderr: "capture";
  timeoutMs: number;
}>;

export type HomeCredentialCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type HomeCredentialCommandRunner = (
  argv: ReadonlyArray<string>,
  io: HomeCredentialCommand,
) => Promise<HomeCredentialCommandResult>;

export function openHomeCredentials(): HomeCredentials {
  return openHomeCredentialsForTests({});
}

/** Test adapter seam; production callers use openHomeCredentials(). */
export function openHomeCredentialsForTests(deps: Readonly<{
  platform?: NodeJS.Platform;
  run?: HomeCredentialCommandRunner;
  credentialIdentityReadCheckpoint?: ((path: string) => Promise<void>) | undefined;
}>): HomeCredentials {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? runSecurity;
  const account = async (vaultPath: string, slot: HomeCredentialSlot): Promise<string> => {
    if (platform !== "darwin") {
      throw new HomeCredentialError("unsupported-platform", "Dome Home credentials require macOS Keychain");
    }
    assertSlot(slot);
    return `${await readCredentialVaultId(vaultPath, deps.credentialIdentityReadCheckpoint)}:${slot}`;
  };
  const invoke = async (
    argv: ReadonlyArray<string>,
    io: HomeCredentialCommand,
    sensitive: ReadonlyArray<string>,
  ): Promise<HomeCredentialCommandResult> => {
    const result = await run(Object.freeze([...argv]), io);
    if (!Number.isSafeInteger(result.exitCode)) {
      throw new HomeCredentialError("failed", "Dome Home Keychain command returned invalid status");
    }
    if (result.exitCode !== 0 && result.exitCode !== 44) {
      const detail = redactDiagnostic(result.stderr, sensitive);
      if (result.exitCode === 36 || /interaction.*not allowed|keychain.*locked/i.test(result.stderr)) {
        throw new HomeCredentialError("locked", "Dome Home Keychain is locked or unavailable for interaction");
      }
      if (result.exitCode === 51 || /user.*cancel|authorization.*denied|auth.*failed/i.test(result.stderr)) {
        throw new HomeCredentialError("denied", "Dome Home Keychain access was denied");
      }
      throw new HomeCredentialError(
        "failed",
        detail.length === 0 ? "Dome Home Keychain command failed" : `Dome Home Keychain command failed: ${detail}`,
      );
    }
    return result;
  };
  const defaultKeychain = async (): Promise<string> => {
    const result = await invoke([
      SECURITY, "default-keychain", "-d", "user",
    ], { stdin: "ignore", stdout: "capture", stderr: "capture", timeoutMs: 10_000 }, []);
    if (result.exitCode === 44) throw new HomeCredentialError("failed", "Dome Home user Keychain is unavailable");
    const line = stripSecurityNewline(result.stdout);
    const quoted = /^[\t ]*("(?:[^"\\]|\\.)*")[\t ]*$/.exec(line);
    if (quoted === null) {
      throw new HomeCredentialError("failed", "Dome Home default Keychain response is malformed");
    }
    let path: unknown;
    try { path = JSON.parse(quoted[1]!); }
    catch { throw new HomeCredentialError("failed", "Dome Home default Keychain response is malformed"); }
    if (typeof path !== "string" || path.length === 0 || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path) {
      throw new HomeCredentialError("failed", "Dome Home default Keychain path is malformed");
    }
    let info: Awaited<ReturnType<typeof lstat>>;
    try { info = await lstat(path); }
    catch { throw new HomeCredentialError("failed", "Dome Home default Keychain is unavailable"); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid())) {
      throw new HomeCredentialError("failed", "Dome Home default Keychain is redirected or not owner-controlled");
    }
    return path;
  };
  return Object.freeze({
    async inspect(vaultPath, slot) {
      const key = await account(vaultPath, slot);
      const keychain = await defaultKeychain();
      const result = await invoke([
        SECURITY, "find-generic-password", "-s", HOME_CREDENTIAL_SERVICE, "-a", key, keychain,
      ], { stdin: "ignore", stdout: "ignore", stderr: "capture", timeoutMs: 10_000 }, [key, keychain]);
      return Object.freeze({ present: result.exitCode === 0 });
    },
    async withSecret(vaultPath, slot, consume) {
      const key = await account(vaultPath, slot);
      const keychain = await defaultKeychain();
      const result = await invoke([
        SECURITY, "find-generic-password", "-w", "-s", HOME_CREDENTIAL_SERVICE, "-a", key, keychain,
      ], { stdin: "ignore", stdout: "capture", stderr: "capture", timeoutMs: 10_000 }, [key, keychain]);
      if (result.exitCode === 44) {
        throw new HomeCredentialError("missing", "Dome Home credential is not configured");
      }
      const secret = stripSecurityNewline(result.stdout);
      if (secret.length === 0 || Buffer.byteLength(secret, "utf8") > 16 * 1024 || secret.includes("\0")) {
        throw new HomeCredentialError("failed", "Dome Home Keychain returned invalid credential bytes");
      }
      try { await consume(secret); }
      catch {
        throw new HomeCredentialError("consumer-failed", "Dome Home credential consumer failed");
      }
    },
    async remove(vaultPath, slot) {
      const key = await account(vaultPath, slot);
      const keychain = await defaultKeychain();
      const result = await invoke([
        SECURITY, "delete-generic-password", "-s", HOME_CREDENTIAL_SERVICE, "-a", key, keychain,
      ], { stdin: "ignore", stdout: "ignore", stderr: "capture", timeoutMs: 10_000 }, [key, keychain]);
      return Object.freeze({ removed: result.exitCode === 0 });
    },
  });
}

async function readCredentialVaultId(
  vaultPath: string,
  checkpoint?: (path: string) => Promise<void>,
): Promise<string> {
  const path = join(resolve(vaultPath), ".dome", "state", "product-host-id");
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { throw new Error("Product Host vault identity is unavailable or redirected"); }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > 1024n ||
      (before.mode & 0o777n) !== 0o600n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))) {
      throw new Error("Product Host vault identity is not a private owner-controlled regular file");
    }
    await checkpoint?.(path);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!sameStableFile(before, after) || named.dev !== after.dev || named.ino !== after.ino ||
      BigInt(bytes.byteLength) !== before.size) {
      throw new Error("Product Host vault identity changed while being read");
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Product Host vault identity is missing or malformed"); }
    const matched = /^([A-Za-z0-9_-]{1,128})\n?$/.exec(text);
    if (matched === null) throw new Error("Product Host vault identity is missing or malformed");
    return matched[1]!;
  } finally { await handle.close(); }
}

function sameStableFile(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mode === right.mode && left.nlink === right.nlink && left.uid === right.uid &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function isHomeSecretEnvironmentName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  const normalized = name.toUpperCase();
  if (normalized === "ANTHROPIC_API_KEY" || normalized === "DOME_TRANSCRIBE_KEY" ||
    normalized === "OPENAI_API_KEY") return true;
  return /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|CLIENT_SECRET|ACCESS_KEY(?:_ID)?|CREDENTIALS?)$/.test(normalized);
}

export function assertHomeEnvironmentHasNoSecrets(
  environment: Iterable<Readonly<{ name: string }>>,
): void {
  for (const entry of environment) {
    if (isHomeSecretEnvironmentName(entry.name)) {
      throw new HomeCredentialMigrationRequiredError();
    }
  }
}

function assertSlot(slot: string): asserts slot is HomeCredentialSlot {
  if (!(HOME_CREDENTIAL_SLOTS as readonly string[]).includes(slot)) {
    throw new Error("unknown Dome Home credential slot");
  }
}

function stripSecurityNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

function redactDiagnostic(value: string, sensitive: ReadonlyArray<string>): string {
  let redacted = value;
  for (const item of sensitive) if (item.length > 0) redacted = redacted.replaceAll(item, "[REDACTED]");
  return redacted
    .replaceAll(homedir(), "~")
    .replace(/(?:sk-ant-|Bearer\s+)[A-Za-z0-9._-]+/gi, "[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1024);
}

async function runSecurity(
  argv: ReadonlyArray<string>,
  io: HomeCredentialCommand,
): Promise<HomeCredentialCommandResult> {
  const child = Bun.spawn([...argv], {
    stdin: io.stdin,
    stdout: io.stdout === "capture" ? "pipe" : io.stdout,
    stderr: io.stderr === "capture" ? "pipe" : "inherit",
    env: { HOME: homedir(), PATH: "/usr/bin:/bin" },
  });
  const abort = setTimeout(() => child.kill("SIGKILL"), io.timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited.finally(() => { clearTimeout(abort); }),
    io.stdout === "capture" ? readRequiredStream(child.stdout, 64 * 1024) : Promise.resolve(""),
    io.stderr === "capture" ? readRequiredStream(child.stderr, 2048) : Promise.resolve(""),
  ]);
  return Object.freeze({ exitCode, stdout, stderr });
}

async function readRequiredStream(
  stream: ReadableStream<Uint8Array> | undefined,
  maximum: number,
): Promise<string> {
  if (stream === undefined) {
    throw new HomeCredentialError("failed", "Dome Home Keychain output was unavailable");
  }
  return await readBoundedStream(stream, maximum);
}

async function readBoundedStream(stream: ReadableStream<Uint8Array>, maximum: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new HomeCredentialError("failed", "Dome Home Keychain output exceeded its bound");
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
