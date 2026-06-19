// The capability vocabulary the HTTP surface authorizes against. A named,
// dependency-free seam: today the granted set is server-wide (one bearer token,
// `author` flipped on by `--allow-write`); later a credential can carry its own
// scoped subset without changing the call sites.

export type Capability = "read" | "capture" | "resolve" | "converse" | "author";

const BASE: readonly Capability[] = ["read", "capture", "resolve", "converse"];

/** The capabilities a server instance grants. `author` is added only with write enabled. */
export function grantedCapabilities(opts: { allowWrite?: boolean | undefined }): ReadonlySet<Capability> {
  return new Set<Capability>(opts.allowWrite === true ? [...BASE, "author"] : BASE);
}

export function has(granted: ReadonlySet<Capability>, cap: Capability): boolean {
  return granted.has(cap);
}
