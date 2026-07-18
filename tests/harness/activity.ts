export type HarnessActivitySnapshot = Readonly<{
  operation: string;
  phase: string;
}>;

const HARNESS_ACTIVITY_PHASES = Object.freeze({
  "harness creation": Object.freeze(["initialize fixture"]),
  "harness cleanup": Object.freeze(["close runtime", "remove temporary vault"]),
  userCommit: Object.freeze([
    "snapshot vault",
    "write owner files",
    "publish Git commit",
    "check always-true invariants",
  ]),
  tick: Object.freeze([
    "snapshot vault",
    "detect Git drift",
    "run compiler host",
    "check always-true invariants",
  ]),
  runCli: Object.freeze([
    "snapshot vault",
    "close harness runtime",
    "dispatch CLI command",
    "reopen harness runtime",
    "check always-true invariants",
  ]),
} satisfies Readonly<Record<string, ReadonlyArray<string>>>);

type ActivityToken = Readonly<{ id: symbol }>;

/**
 * In-memory attribution for a scenario's currently awaited Harness boundary.
 * It is diagnostic only: it owns no timeout, cancellation, or durable state.
 */
export class HarnessActivity {
  private current: Readonly<{
    token: ActivityToken;
    snapshot: HarnessActivitySnapshot;
  }> | null = null;

  begin(operation: string, phase: string): ActivityToken {
    const token = Object.freeze({ id: Symbol(operation) });
    this.current = Object.freeze({
      token,
      snapshot: Object.freeze({ operation, phase }),
    });
    return token;
  }

  advance(token: ActivityToken, phase: string): void {
    if (this.current?.token !== token) return;
    this.current = Object.freeze({
      token,
      snapshot: Object.freeze({
        operation: this.current.snapshot.operation,
        phase,
      }),
    });
  }

  end(token: ActivityToken): void {
    if (this.current?.token === token) this.current = null;
  }

  async track<T>(
    operation: string,
    initialPhase: string,
    work: (advance: (phase: string) => void) => Promise<T>,
  ): Promise<T> {
    const token = this.begin(operation, initialPhase);
    try {
      return await work((phase) => this.advance(token, phase));
    } finally {
      this.end(token);
    }
  }

  snapshot(): HarnessActivitySnapshot | null {
    return this.current?.snapshot ?? null;
  }
}

export type ScenarioDeadlineTimer = ReturnType<typeof setTimeout>;

export function scheduleScenarioDeadlineDiagnostic(input: Readonly<{
  timeoutMs: number;
  activity: () => HarnessActivitySnapshot | null;
  write?: (message: string) => void;
  schedule?: (
    callback: () => void,
    milliseconds: number,
  ) => ScenarioDeadlineTimer;
  cancel?: (timer: ScenarioDeadlineTimer) => void;
}>): () => void {
  const leadMs = Math.min(1_000, Math.max(1, Math.floor(input.timeoutMs / 10)));
  const diagnosticAtMs = Math.max(1, input.timeoutMs - leadMs);
  const schedule = input.schedule ?? ((callback, milliseconds) =>
    setTimeout(callback, milliseconds));
  const cancel = input.cancel ?? ((timer) => clearTimeout(timer));
  // Harness.runCli captures console.error while it dispatches. Write to the
  // underlying stream so a stalled command cannot swallow its own deadline
  // attribution inside an output buffer that never returns.
  const write = input.write ?? ((message) => process.stderr.write(`${message}\n`));
  const timer = schedule(() => {
    const active = input.activity();
    const owner = active === null
      ? "scenario body (no instrumented Harness operation active)"
      : renderSafeOwner(active);
    write(
      "[scenario deadline] scenario is still running at "
      + `${diagnosticAtMs}ms of ${input.timeoutMs}ms; active owner: ${owner}`,
    );
  }, diagnosticAtMs);
  return () => cancel(timer);
}

function renderSafeOwner(active: HarnessActivitySnapshot): string {
  if (!Object.hasOwn(HARNESS_ACTIVITY_PHASES, active.operation)) {
    return "unrecognized instrumented Harness operation";
  }
  const phases = HARNESS_ACTIVITY_PHASES[
    active.operation as keyof typeof HARNESS_ACTIVITY_PHASES
  ];
  if (!phases.includes(active.phase)) {
    return "unrecognized instrumented Harness operation";
  }
  return `${active.operation} / ${active.phase}`;
}
