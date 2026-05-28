// cli/commands/doctor: the `dome doctor` command — reserved for v1.x.
//
// Per [[wiki/specs/cli]] §"dome doctor [--repair]" (reserved for v1.x),
// `dome doctor` is the engine-substrate health-check verb. v1.0 reserves
// the command name and ships no checks; v1.x implements the surface as
// a view-phase command-triggered processor (`dome.health.render-report`)
// in the deferred `dome.health` first-party bundle, with `--repair`
// applying the safe subset of mitigations via answer-handler processors.
//
// v1.0 placeholder behavior:
//   - `dome doctor`        → prints a one-line notice and exits 0.
//   - `dome doctor --repair` → exits 64 with the same pointer.
//
// Why this is a stub rather than the v0.5 surface: the previous
// `dome inspect <subject>` shape was renamed to `dome inspect
// <subject>` in the v1.0 CLI surface recut (the read half lives there);
// the `--repair` / `--outbox-replay` / `--reset-quarantined-processors`
// flags are retired in favor of the engine-asks model (engine emits
// QuestionEffects on substrate-stuck conditions; user answers via
// `dome answer <question-id>`; the `dome.health` bundle's answer-handler
// processors apply the mutation). See [[wiki/specs/cli]] for the full
// design.

const RESERVED_NOTICE =
  "dome doctor: no health checks ship in v1.0; reserved for v1.x. " +
  "For the v1.0 read surface, use `dome inspect <subject>`. " +
  "See `docs/wiki/specs/cli.md` §`dome doctor` for the design.";

export type RunDoctorOptions = {
  readonly repair?: boolean | undefined;
};

/**
 * Execute `dome doctor`. v1.0 stub.
 *
 * - Without flags: prints the reserved notice, exits 0.
 * - With `--repair`: exits 64 (the repair surface is not implemented).
 */
export async function runDoctor(
  options: RunDoctorOptions = {},
): Promise<number> {
  if (options.repair === true) {
    console.error(
      "dome doctor --repair: not implemented in v1.0. " +
        "The --repair surface is reserved for v1.x (engine-substrate " +
        "mitigations via the dome.health bundle's answer-handler processors). " +
        "See `docs/wiki/specs/cli.md` §`dome doctor`.",
    );
    return 64;
  }
  console.log(RESERVED_NOTICE);
  return 0;
}
