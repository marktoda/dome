// cli/exit-codes: CLI exit-code constants per sysexits(3).
//   EX_OK (0)       — successful termination.
//   EX_USAGE (64)   — command-line usage error (invalid flag, missing arg,
//                     unusable vault state the user must fix first).
//   EX_TEMPFAIL (75)— temporary failure; retry may succeed (branch lock held
//                     by another compiler host — see dome sync/serve).
export const EX_OK = 0;
export const EX_USAGE = 64;
export const EX_TEMPFAIL = 75;
