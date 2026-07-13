// product-host/write-admission: one fail-closed launch decision for Dome Home.
//
// Upgrade probation is intentionally not an "off" boolean sprinkled through
// callers. It is a distinct launch mode whose only possible admission result
// in this checkpoint is closed. A later upgrade transaction may add a
// committed-evidence launch mode; changing an environment variable must never
// be enough to open writes.

export type ProductArtifactIdentity = {
  readonly id: string;
  readonly version: string;
};

export type ProductHostLaunch =
  | {
      readonly kind: "normal";
      readonly artifact?: ProductArtifactIdentity | undefined;
    }
  | {
      readonly kind: "upgrade-probation";
      /** Trusted controllers pass only identity from verifyHomeArtifact. */
      readonly artifact: ProductArtifactIdentity;
    };

export type ProductHostWriteAdmission = {
  readonly mode: ProductHostLaunch["kind"];
  readonly artifact: ProductArtifactIdentity;
  readonly writesAdmitted: boolean;
};

/**
 * Resolve the complete write-admission truth once, before any stateful opener.
 * Unknown/malformed launch input throws before the host touches vault state.
 */
export function resolveProductHostWriteAdmission(input: {
  readonly launch?: ProductHostLaunch | undefined;
  readonly developmentVersion: string;
  readonly developmentArtifactId: string;
}): ProductHostWriteAdmission {
  const launch = input.launch ?? { kind: "normal" as const };
  if (launch.kind === "upgrade-probation") {
    const artifact = strictArtifactIdentity(launch.artifact);
    return Object.freeze({
      mode: launch.kind,
      artifact,
      writesAdmitted: false,
    });
  }
  if (launch.kind !== "normal") {
    throw new Error("Product Host launch mode is unknown");
  }
  const artifact = launch.artifact === undefined
    ? developmentArtifactIdentity(input.developmentArtifactId, input.developmentVersion)
    : artifactIdentity(launch.artifact);
  return Object.freeze({
    mode: launch.kind,
    artifact,
    writesAdmitted: true,
  });
}

function strictArtifactIdentity(input: ProductArtifactIdentity): ProductArtifactIdentity {
  const artifact = artifactIdentity(input);
  if (!/^[a-f0-9]{64}$/.test(artifact.id)) {
    throw new Error("upgrade probation requires an exact 64-character artifact id");
  }
  return artifact;
}

function developmentArtifactIdentity(id: string, version: string): ProductArtifactIdentity {
  if (id !== "development" && !boundedText(id)) {
    throw new Error("Product Host development artifact id is invalid");
  }
  if (!boundedText(version)) throw new Error("Product Host product version is invalid");
  return Object.freeze({ id, version });
}

function artifactIdentity(input: ProductArtifactIdentity): ProductArtifactIdentity {
  if (typeof input !== "object" || input === null ||
    !boundedText(input.id) || !boundedText(input.version)) {
    throw new Error("Product Host artifact identity is invalid");
  }
  return Object.freeze({ id: input.id, version: input.version });
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024 &&
    !value.includes("\0") && !/[\r\n]/.test(value);
}
