// platform/bounded-command: one deep host-process Module for small captured commands.
// Callers choose argv and resource bounds; this module owns exact spawning,
// concurrent bounded drains, deadline enforcement, termination, and reaping.

import { basename } from "node:path";

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const TERMINATION_GRACE_MS = 250;
const KILL_WAIT_MS = 1_000;
const TERMINAL_DRAIN_MS = 1_000;

export type BoundedCommandErrorKind = "spawn" | "timeout" | "output-limit" | "termination";

export class BoundedCommandError extends Error {
  readonly kind: BoundedCommandErrorKind;
  readonly stream: "stdout" | "stderr" | undefined;
  readonly spawnCode: string | undefined;

  constructor(
    kind: BoundedCommandErrorKind,
    message: string,
    options: {
      readonly spawnCode?: string | undefined;
      readonly stream?: "stdout" | "stderr" | undefined;
    } = {},
  ) {
    super(message);
    this.name = "BoundedCommandError";
    this.kind = kind;
    this.stream = options.stream;
    this.spawnCode = options.spawnCode;
  }
}

export type BoundedCommandResult = Readonly<{
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

/**
 * Run one exact argv without a shell. `outputLimitBytes` applies independently
 * to stdout and stderr. Both streams are drained concurrently while the child
 * is live; timeout covers child exit and both stream closures.
 */
export async function runBoundedCommand(options: Readonly<{
  argv: ReadonlyArray<string>;
  timeoutMs: number;
  outputLimitBytes: number;
  env?: Record<string, string | undefined> | undefined;
}>): Promise<BoundedCommandResult> {
  validateOptions(options);
  const label = safeCommandLabel(options.argv[0]!);
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...options.argv], {
      ...(options.env === undefined ? {} : { env: options.env }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    throw new BoundedCommandError("spawn", `${label} could not start`, { spawnCode: safeErrorCode(error) });
  }

  let signalOverflow!: (stream: "stdout" | "stderr") => void;
  const overflow = new Promise<"stdout" | "stderr">((resolve) => { signalOverflow = resolve; });
  const stdout = drainBounded(child.stdout, options.outputLimitBytes, () => signalOverflow("stdout"));
  const stderr = drainBounded(child.stderr, options.outputLimitBytes, () => signalOverflow("stderr"));
  const allSettled = Promise.allSettled([child.exited, stdout.promise, stderr.promise]);
  const completed = Promise.all([child.exited, stdout.promise, stderr.promise]).then(
    ([exitCode, stdoutBytes, stderrBytes]) => ({ kind: "completed" as const, exitCode, stdoutBytes, stderrBytes }),
    () => ({ kind: "stream-error" as const }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<{ readonly kind: "timeout" }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), options.timeoutMs);
  });
  const outcome = await Promise.race([
    completed,
    overflow.then((stream) => ({ kind: "output-limit" as const, stream })),
    timedOut,
  ]);
  if (timer !== undefined) clearTimeout(timer);

  if (outcome.kind === "completed") {
    return Object.freeze({
      exitCode: outcome.exitCode,
      stdout: outcome.stdoutBytes.toString("utf8"),
      stderr: outcome.stderrBytes.toString("utf8"),
    });
  }

  const primary = outcome.kind === "timeout"
    ? new BoundedCommandError("timeout", `${label} timed out after ${options.timeoutMs}ms`)
    : outcome.kind === "output-limit"
      ? new BoundedCommandError(
        "output-limit",
        `${label} ${outcome.stream} exceeded ${options.outputLimitBytes} bytes`,
        { stream: outcome.stream },
      )
      : new BoundedCommandError("termination", `${label} output stream failed`);

  let terminationFailure: unknown;
  try {
    await terminate(child, label);
  } catch (error) {
    terminationFailure = error;
  }
  await Promise.allSettled([stdout.cancel(), stderr.cancel()]);
  const reaped = await settles(allSettled, TERMINAL_DRAIN_MS);
  if (terminationFailure !== undefined || !reaped) {
    throw new BoundedCommandError("termination", `${label} did not settle after forced termination`);
  }
  throw primary;
}

function validateOptions(options: Readonly<{
  argv: ReadonlyArray<string>;
  timeoutMs: number;
  outputLimitBytes: number;
}>): void {
  if (options.argv.length === 0 || options.argv.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new RangeError("bounded command argv must contain nonempty strings");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("bounded command timeoutMs is outside the supported range");
  }
  if (!Number.isInteger(options.outputLimitBytes) || options.outputLimitBytes < 1 ||
      options.outputLimitBytes > MAX_OUTPUT_LIMIT_BYTES) {
    throw new RangeError("bounded command outputLimitBytes is outside the supported range");
  }
}

type Drain = Readonly<{
  promise: Promise<Buffer>;
  cancel: () => Promise<void>;
}>;

function drainBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
  onOverflow: () => void,
): Drain {
  const reader = stream.getReader();
  let overflowed = false;
  const promise = (async () => {
    const chunks: Uint8Array[] = [];
    let retained = 0;
    let seen = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        seen += next.value.byteLength;
        if (retained < maximum) {
          const keep = next.value.subarray(0, Math.min(next.value.byteLength, maximum - retained));
          if (keep.byteLength > 0) {
            chunks.push(keep);
            retained += keep.byteLength;
          }
        }
        if (!overflowed && seen > maximum) {
          overflowed = true;
          onOverflow();
        }
      }
      return Buffer.concat(chunks, retained);
    } finally {
      reader.releaseLock();
    }
  })();
  return Object.freeze({
    promise,
    cancel: async () => { try { await reader.cancel(); } catch {} },
  });
}

async function terminate(child: Bun.Subprocess<"ignore", "pipe", "pipe">, label: string): Promise<void> {
  try { child.kill("SIGTERM"); } catch {}
  if (await settles(child.exited, TERMINATION_GRACE_MS)) return;
  try { child.kill("SIGKILL"); } catch {}
  if (!await settles(child.exited, KILL_WAIT_MS)) {
    throw new Error(`${label} process did not exit after SIGKILL`);
  }
}

async function settles(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function safeCommandLabel(argv0: string): string {
  const cleaned = basename(argv0).replace(/[^\x21-\x7e]/g, "?").slice(0, 64);
  return cleaned === "" ? "command" : cleaned;
}

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : undefined;
}
