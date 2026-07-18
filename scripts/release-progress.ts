export type ReleaseProgressState = "started" | "completed" | "failed";

export type ReleaseProgress = Readonly<{
  phase: string;
  state: ReleaseProgressState;
  elapsedMs: number;
}>;

export type ReleaseProgressReporter = (progress: ReleaseProgress) => void | PromiseLike<void>;

export function formatReleaseProgress(progress: ReleaseProgress): string {
  assertReleasePhase(progress.phase);
  if (!["started", "completed", "failed"].includes(progress.state)) {
    throw new Error("release progress state is invalid");
  }
  if (!Number.isInteger(progress.elapsedMs) || progress.elapsedMs < 0) {
    throw new Error("release progress duration is invalid");
  }
  return `packed-product-rehearsal: phase=${progress.phase} state=${progress.state} elapsed_ms=${progress.elapsedMs}`;
}

/** Report only a strictly shaped phase name, state, and duration—never owner data or paths. */
export async function runReleasePhase<T>(
  phase: string,
  report: ReleaseProgressReporter | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  assertReleasePhase(phase);
  if (report !== undefined && typeof report !== "function") {
    throw new Error("release progress reporter is invalid");
  }
  if (typeof operation !== "function") throw new Error("release phase operation is invalid");
  const startedAt = performance.now();
  reportSafely(report, Object.freeze({ phase, state: "started", elapsedMs: 0 }));
  try {
    const value = await operation();
    reportSafely(report, Object.freeze({
      phase,
      state: "completed",
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    }));
    return value;
  } catch (error) {
    reportSafely(report, Object.freeze({
      phase,
      state: "failed",
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    }));
    throw error;
  }
}

function assertReleasePhase(phase: string): void {
  if (phase.length < 1 || phase.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(phase)) {
    throw new Error("release progress phase is invalid");
  }
}

/** Diagnostics are best-effort and can never prevent or mask the release operation. */
function reportSafely(report: ReleaseProgressReporter | undefined, progress: ReleaseProgress): void {
  if (report === undefined) return;
  try {
    const result = report(progress);
    if (result !== undefined) void Promise.resolve(result).catch(() => {});
  } catch {}
}
