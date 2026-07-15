// product-host/home-credentials: the closed macOS Keychain seam for Dome
// Home's shipped Anthropic model provider. The native helper owns every item
// lookup and provider launch. The Dome Bun host never receives secret bytes;
// only the fixed provider Bun child receives them in its explicit environment.

import { homedir } from "node:os";
import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HOME_CREDENTIAL_SERVICE = "com.dome.home.credentials.v1" as const;
export const HOME_MODEL_CREDENTIAL_SLOT = "model.anthropic.api-key" as const;

export type HomeCredentialErrorCode =
  | "unsupported-platform"
  | "missing"
  | "locked"
  | "denied"
  | "failed";

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
  inspect(vaultPath: string): Promise<HomeCredentialInspection>;
  configure(vaultPath: string): Promise<void>;
  check(vaultPath: string): Promise<HomeCredentialInspection>;
  remove(vaultPath: string): Promise<HomeCredentialRemoval>;
  modelProviderCommand(vaultPath: string): Promise<ReadonlyArray<string>>;
}>;

export type HomeCredentialHelperRunner = (
  argv: ReadonlyArray<string>,
  options?: Readonly<{ timeoutMs?: number }>,
) => Promise<Readonly<{ exitCode: number }>>;

const DEFAULT_HELPER_TIMEOUT_MS = 1_000;

export function openHomeCredentials(options: Readonly<{ helperPath?: string }> = {}): HomeCredentials {
  return openHomeCredentialsForTests(options);
}

/** Test adapter seam; production callers use openHomeCredentials(). */
export function openHomeCredentialsForTests(deps: Readonly<{
  platform?: NodeJS.Platform;
  runHelper?: HomeCredentialHelperRunner;
  helperPath?: string;
  helperTimeoutMs?: number;
}>): HomeCredentials {
  const platform = deps.platform ?? process.platform;
  const runHelper = deps.runHelper ?? runHomeCredentialHelper;
  const helperTimeoutMs = deps.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  if (!Number.isFinite(helperTimeoutMs) || helperTimeoutMs <= 0) {
    throw new RangeError("helperTimeoutMs must be a positive finite number");
  }
  let mutationTail = Promise.resolve();

  const command = async (
    vaultPath: string,
    operation: "replace" | "inspect" | "check" | "remove" | "run-model-provider",
  ): Promise<ReadonlyArray<string>> => {
    if (platform !== "darwin") {
      throw new HomeCredentialError("unsupported-platform", "Dome Home credentials require macOS Keychain");
    }
    const [helper, vault] = await Promise.all([
      validatedHelperPath(deps.helperPath ?? defaultCredentialHelperPath()),
      canonicalVaultPath(vaultPath),
    ]);
    return Object.freeze([helper, operation, vault]);
  };

  const invoke = async (
    vaultPath: string,
    operation: "replace" | "inspect" | "check" | "remove",
  ): Promise<number> => {
    const argv = await command(vaultPath, operation);
    let result: Readonly<{ exitCode: number }>;
    try {
      result = await runHelper(
        argv,
        operation === "replace" ? {} : { timeoutMs: helperTimeoutMs },
      );
    } catch {
      throw new HomeCredentialError("failed", "Dome Home credential helper failed");
    }
    if (!Number.isSafeInteger(result.exitCode)) {
      throw new HomeCredentialError("failed", "Dome Home credential helper returned invalid status");
    }
    if (result.exitCode === 3) {
      throw new HomeCredentialError("denied", "Dome Home credential access was denied or cancelled");
    }
    if (result.exitCode === 5) {
      throw new HomeCredentialError("locked", "Dome Home Keychain is locked or unavailable");
    }
    if (result.exitCode !== 0 && result.exitCode !== 44) {
      throw new HomeCredentialError("failed", "Dome Home credential helper failed");
    }
    return result.exitCode;
  };

  // Serialize mutations inside this process. Provider children do not join this
  // queue: each child asks the helper for the current Keychain value at launch.
  const serializeMutation = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = mutationTail;
    let release!: () => void;
    mutationTail = new Promise<void>((resolveTail) => { release = resolveTail; });
    await previous;
    try { return await work(); }
    finally { release(); }
  };

  return Object.freeze({
    async inspect(vaultPath) {
      return Object.freeze({ present: await invoke(vaultPath, "inspect") === 0 });
    },
    async configure(vaultPath) {
      await serializeMutation(async () => {
        if (await invoke(vaultPath, "replace") !== 0 || await invoke(vaultPath, "check") !== 0) {
          throw new HomeCredentialError("failed", "Dome Home Keychain did not retain the model credential");
        }
      });
    },
    async check(vaultPath) {
      const result = await invoke(vaultPath, "check");
      if (result === 44) throw new HomeCredentialError("missing", "Dome Home model credential is not configured");
      return Object.freeze({ present: true });
    },
    async remove(vaultPath) {
      return await serializeMutation(async () =>
        Object.freeze({ removed: await invoke(vaultPath, "remove") === 0 }));
    },
    async modelProviderCommand(vaultPath) {
      return await command(vaultPath, "run-model-provider");
    },
  });
}

function defaultCredentialHelperPath(): string {
  return fileURLToPath(new URL("../../../runtime/dome-keychain-helper", import.meta.url));
}

async function canonicalVaultPath(input: string): Promise<string> {
  const requested = resolve(input);
  let canonical: string;
  try { canonical = await realpath(requested); }
  catch { throw new HomeCredentialError("failed", "Dome Home vault is unavailable"); }
  return canonical;
}

async function validatedHelperPath(input: string): Promise<string> {
  const path = resolve(input);
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(path); }
  catch { throw new HomeCredentialError("failed", "Dome Home credential helper is unavailable"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
    (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0 ||
    (typeof process.getuid === "function" && info.uid !== process.getuid()) ||
    await realpath(path) !== path) {
    throw new HomeCredentialError("failed", "Dome Home credential helper is not a direct owner-controlled executable");
  }
  return path;
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

/** Small process seam: callers explicitly opt into a hard timeout. */
export async function runHomeCredentialHelper(
  argv: ReadonlyArray<string>,
  options: Readonly<{ timeoutMs?: number }> = {},
): Promise<Readonly<{ exitCode: number }>> {
  if (options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new RangeError("timeoutMs must be a positive finite number");
  }
  const child = Bun.spawn([...argv], {
    stdin: "inherit",
    stdout: "ignore",
    stderr: "inherit",
    env: { HOME: homedir(), PATH: "/usr/bin:/bin" },
  });
  if (options.timeoutMs === undefined) {
    return Object.freeze({ exitCode: await child.exited });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ kind: "exited" as const, exitCode })),
    new Promise<{ readonly kind: "timed-out" }>((resolveTimeout) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveTimeout({ kind: "timed-out" });
      }, options.timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (outcome.kind === "timed-out") {
    throw new Error(`Dome Home credential helper exceeded ${options.timeoutMs}ms`);
  }
  return Object.freeze({ exitCode: outcome.exitCode });
}
