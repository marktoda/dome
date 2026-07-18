import { types } from "node:util";

const abortSignalAborted = captureAbortSignalAborted();
const eventTargetAddEventListener = EventTarget.prototype.addEventListener;
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener;

function captureAbortSignalAborted(): (this: AbortSignal) => boolean {
  const getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;
  if (getter === undefined) throw new Error("AbortSignal.aborted intrinsic is unavailable");
  return getter as (this: AbortSignal) => boolean;
}

function readAbortSignalAborted(signal: AbortSignal): boolean {
  return Reflect.apply(abortSignalAborted, signal, []) as boolean;
}

/** Observe one caller-owned signal without consulting its mutable property surface. */
export function isReleaseAbortRequested(signal: AbortSignal | undefined): boolean {
  if (signal === undefined) return false;
  if (types.isProxy(signal)) throw new Error("release command signal is invalid");
  try {
    return readAbortSignalAborted(signal);
  } catch {
    throw new Error("release command signal is invalid");
  }
}

function addIntrinsicAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(eventTargetAddEventListener, signal, ["abort", listener, { once: true }]);
}

function removeIntrinsicAbortListener(signal: AbortSignal, listener: EventListener): void {
  Reflect.apply(eventTargetRemoveEventListener, signal, ["abort", listener]);
}

export type ReleaseCommandResult = Readonly<{ stdout: Buffer; stderr: Buffer; exitCode: number }>;

export type ReleaseCommandOptions = Readonly<{
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  allowFailure?: boolean;
}>;

/**
 * Run one release command with bounded output, time, and process-tree ownership.
 *
 * Release commands frequently invoke Bun/npm wrappers. A direct-child kill is
 * insufficient because descendants inherit the output pipes; the unresolved
 * readers can then keep the rehearsal alive forever. On Unix every command is
 * therefore placed in a private process group and a failure kills that group.
 */
export async function runBoundedReleaseCommand(
  command: ReadonlyArray<string>,
  cwd: string,
  options: ReleaseCommandOptions,
): Promise<ReleaseCommandResult> {
  const snapshot = snapshotReleaseCommand(command, cwd, options);
  const argv = snapshot.command;
  const executable = argv[0]!;
  if (snapshot.signalInitiallyAborted) throw new Error(`${executable} was aborted`);
  const ownsProcessGroup = process.platform !== "win32";
  const child = Bun.spawn([...argv], {
    cwd: snapshot.cwd,
    env: snapshot.env,
    stdout: "pipe",
    stderr: "pipe",
    ...(ownsProcessGroup ? { detached: true } : {}),
  });
  const killOwnedProcessGroup = (): void => {
    if (ownsProcessGroup) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch {}
    }
    try { child.kill("SIGKILL"); } catch {}
  };
  const stdoutReader = child.stdout.getReader();
  const stderrReader = child.stderr.getReader();
  const collect = async (
    reader: typeof stdoutReader,
    maxBytes: number,
    label: string,
  ): Promise<Buffer> => {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new Error(`${executable} ${label} exceeded its byte budget`);
        chunks.push(next.value);
      }
      return Buffer.concat(chunks, bytes);
    } finally {
      reader.releaseLock();
    }
  };
  const stdout = collect(stdoutReader, snapshot.maxStdoutBytes, "stdout");
  const stderr = collect(stderrReader, snapshot.maxStderrBytes, "stderr");
  const exited = child.exited;
  const drained = Promise.allSettled([stdout, stderr, exited]);
  const waitWithin = async <T>(value: Promise<T>, milliseconds: number): Promise<
    | Readonly<{ kind: "settled"; value: T }>
    | Readonly<{ kind: "timeout" }>
  > => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        value.then((result) => Object.freeze({ kind: "settled" as const, value: result })),
        new Promise<Readonly<{ kind: "timeout" }>>((resolveTimeout) => {
          deadline = setTimeout(() => resolveTimeout(Object.freeze({ kind: "timeout" as const })), milliseconds);
          deadline.unref?.();
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
  };
  type DrainOutcome =
    | Readonly<{ kind: "natural"; results: Awaited<typeof drained> }>
    | Readonly<{ kind: "forced"; results: Awaited<typeof drained> | null }>;
  const drainOwnedProcess = async (): Promise<DrainOutcome> => {
    const prompt = await waitWithin(drained, 2_000);
    if (prompt.kind === "settled") {
      return Object.freeze({ kind: "natural" as const, results: prompt.value });
    }
    const cancelReader = async (reader: typeof stdoutReader): Promise<void> => {
      try { await reader.cancel("release command cleanup timed out"); } catch {}
    };
    await Promise.allSettled([cancelReader(stdoutReader), cancelReader(stderrReader)]);
    child.unref();
    const cancelled = await waitWithin(drained, 100);
    return Object.freeze({
      kind: "forced" as const,
      results: cancelled.kind === "settled" ? cancelled.value : null,
    });
  };
  const directExit = exited.then((exitCode) => Object.freeze({ exitCode }));
  // A stream failure must interrupt a still-running command. Successful EOF
  // carries no ownership information; the direct process exit does.
  const outputFailure = Promise.all([stdout, stderr]).then<never>(
    () => new Promise<never>(() => {}),
    (error) => Promise.reject(error),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${executable} timed out after ${snapshot.timeoutMs}ms`)),
      snapshot.timeoutMs,
    );
  });
  let removeAbort = (): void => {};
  const aborted = snapshot.signal === undefined ? null : new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => reject(new Error(`${executable} was aborted`));
    addIntrinsicAbortListener(snapshot.signal!, onAbort);
    removeAbort = () => {
      try { removeIntrinsicAbortListener(snapshot.signal!, onAbort); } catch {}
    };
    if (readAbortSignalAborted(snapshot.signal!)) onAbort();
  });
  let outcome: Awaited<typeof directExit>;
  try {
    outcome = await Promise.race(
      aborted === null ? [directExit, outputFailure, timeout] : [directExit, outputFailure, timeout, aborted],
    );
  } catch (error) {
    killOwnedProcessGroup();
    await drainOwnedProcess();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try { removeAbort(); } catch {}
  }
  // Direct exit closes the command's ownership lifetime. A successful wrapper
  // can orphan descendants just as a failed wrapper can, so retire the whole
  // private group before waiting for inherited output pipes to reach EOF.
  killOwnedProcessGroup();
  const drain = await drainOwnedProcess();
  const outputResults = drain.results?.slice(0, 2) ?? [];
  const budgetFailure = outputResults.find((result) =>
    result.status === "rejected" && result.reason instanceof Error &&
    result.reason.message.includes("exceeded its byte budget"));
  if (budgetFailure?.status === "rejected") throw budgetFailure.reason;
  if (drain.kind !== "natural") {
    throw new Error("release command output ownership is incomplete after direct exit");
  }
  const [stdoutResult, stderrResult] = drain.results;
  const collectionFailure = [stdoutResult, stderrResult].find((result) => result.status === "rejected");
  if (collectionFailure?.status === "rejected") {
    if (collectionFailure.reason instanceof Error) throw collectionFailure.reason;
    throw new Error("release command output collection failed after direct exit");
  }
  if (stdoutResult.status !== "fulfilled" || stderrResult.status !== "fulfilled") {
    throw new Error("release command output collection failed after direct exit");
  }
  const stdoutBytes = stdoutResult.value;
  const stderrBytes = stderrResult.value;
  if (outcome.exitCode === 0 || snapshot.allowFailure) {
    return Object.freeze({ stdout: stdoutBytes, stderr: stderrBytes, exitCode: outcome.exitCode });
  }
  const diagnostic = (stderrBytes.byteLength === 0 ? stdoutBytes : stderrBytes).toString("utf8").trim();
  throw new Error(`${executable} failed (${outcome.exitCode}): ${diagnostic}`);
}

type ReleaseCommandSnapshot = Readonly<{
  command: ReadonlyArray<string>;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes: number;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  signalInitiallyAborted: boolean;
  allowFailure: boolean;
}>;

function snapshotReleaseCommand(
  command: ReadonlyArray<string>,
  cwd: string,
  options: ReleaseCommandOptions,
): ReleaseCommandSnapshot {
  if (!Array.isArray(command) || types.isProxy(command) || command.length < 1 || command.length > 128) {
    throw new Error("release command argv is invalid");
  }
  const argv: string[] = [];
  for (let index = 0; index < command.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(command, String(index));
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" ||
      descriptor.value.length < 1 || descriptor.value.length > 32_768) {
      throw new Error("release command argv is invalid");
    }
    argv.push(descriptor.value);
  }
  if (typeof cwd !== "string" || cwd.length < 1 || cwd.length > 32_768 ||
    options === null || typeof options !== "object" || types.isProxy(options)) {
    throw new Error("release command options are invalid");
  }
  const readOption = (name: keyof ReleaseCommandOptions): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name);
    if (descriptor === undefined) return undefined;
    if (!("value" in descriptor)) throw new Error("release command options are invalid");
    return descriptor.value;
  };
  const timeoutMs = readOption("timeoutMs");
  const maxStdoutBytes = readOption("maxStdoutBytes");
  const maxStderrBytes = readOption("maxStderrBytes");
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0 || (timeoutMs as number) > 60 * 60_000) {
    throw new Error("release command timeout is invalid");
  }
  for (const value of [maxStdoutBytes, maxStderrBytes]) {
    if (!Number.isInteger(value) || (value as number) <= 0 || (value as number) > 64 * 1024 * 1024) {
      throw new Error("release command output bound is invalid");
    }
  }
  const allowedOptions = new Set(["timeoutMs", "maxStdoutBytes", "maxStderrBytes", "env", "signal", "allowFailure"]);
  if (Object.getOwnPropertySymbols(options).length > 0 || Object.keys(options).some((key) => !allowedOptions.has(key))) {
    throw new Error("release command options are invalid");
  }
  const rawEnv = readOption("env");
  // Bun exposes process.env through trusted platform accessors. Snapshot that
  // special object eagerly; caller-supplied environments remain data-only.
  const env = rawEnv === undefined || rawEnv === process.env
    ? snapshotTrustedEnvironment()
    : snapshotEnvironment(rawEnv);
  const signal = readOption("signal");
  const signalInitiallyAborted = isReleaseAbortRequested(signal as AbortSignal | undefined);
  const allowFailure = readOption("allowFailure");
  if (allowFailure !== undefined && typeof allowFailure !== "boolean") {
    throw new Error("release command failure policy is invalid");
  }
  return Object.freeze({
    command: Object.freeze(argv),
    cwd,
    timeoutMs: timeoutMs as number,
    maxStdoutBytes: maxStdoutBytes as number,
    maxStderrBytes: maxStderrBytes as number,
    env,
    ...(signal === undefined ? {} : { signal: signal as AbortSignal }),
    signalInitiallyAborted,
    allowFailure: allowFailure === true,
  });
}

function snapshotEnvironment(value: unknown): Record<string, string | undefined> {
  if (value === null || typeof value !== "object" || types.isProxy(value)) {
    throw new Error("release command environment is invalid");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("release command environment is invalid");
  }
  const keys = Object.keys(value);
  if (keys.length > 4_096) throw new Error("release command environment is invalid");
  const output = Object.create(null) as Record<string, string | undefined>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!validEnvironmentKey(key) || descriptor === undefined || !("value" in descriptor) ||
      (typeof descriptor.value !== "string" && descriptor.value !== undefined) ||
      (typeof descriptor.value === "string" && descriptor.value.includes("\0"))) {
      throw new Error("release command environment is invalid");
    }
    Object.defineProperty(output, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return output;
}

function snapshotTrustedEnvironment(): Record<string, string | undefined> {
  const output = Object.create(null) as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(process.env)) {
    if (!validEnvironmentKey(key) || (value !== undefined && value.includes("\0"))) continue;
    Object.defineProperty(output, key, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return output;
}

function validEnvironmentKey(key: string): boolean {
  return key.length > 0 && !key.includes("\0") && !key.includes("=");
}
