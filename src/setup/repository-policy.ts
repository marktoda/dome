import { posix } from "node:path";

/**
 * The repository-policy Module owns the complete content-free decision for one
 * inspected node. Filesystem inspection supplies facts; contracts and
 * renderers consume only this canonical result.
 */
export const SETUP_REPOSITORY_CANDIDATE_KINDS = ["file", "directory", "symlink", "special"] as const;
export const SETUP_REPOSITORY_DISPOSITIONS = ["already-tracked", "baseline", "preserve-untracked", "blocked"] as const;
export const SETUP_REPOSITORY_REASONS = [
  "safe-owner-file",
  "directory-not-tracked",
  "ignored-by-owner",
  "sensitive-name",
  "large-file",
  "nested-repository",
  "symlink-internal",
  "symlink-external",
  "special-file",
  "hard-linked-file",
  "dome-private",
  "private-case-alias",
] as const;
export const SETUP_REPOSITORY_MAX_BASELINE_FILE_BYTES = 16 * 1024 * 1024;

export type SetupRepositoryCandidate = Readonly<{
  path: string;
  kind: typeof SETUP_REPOSITORY_CANDIDATE_KINDS[number];
  bytes: number;
  tracking: "tracked" | "untracked" | "ignored" | "other";
  disposition: typeof SETUP_REPOSITORY_DISPOSITIONS[number];
  reason: typeof SETUP_REPOSITORY_REASONS[number];
}>;

export type SetupRepositoryObservation = Readonly<{
  path: string;
  kind: SetupRepositoryCandidate["kind"];
  bytes: number;
  tracking: SetupRepositoryCandidate["tracking"];
  gitDirect: boolean;
  observedReason: SetupRepositoryCandidate["reason"];
}>;

export function deriveSetupRepositoryCandidate(
  observation: SetupRepositoryObservation,
): SetupRepositoryCandidate {
  if (!safeRepositoryPath(observation.path)) throw new Error("repository candidate path is unsafe");
  if (!SETUP_REPOSITORY_CANDIDATE_KINDS.includes(observation.kind) ||
    !["tracked", "untracked", "ignored", "other"].includes(observation.tracking) ||
    !Number.isSafeInteger(observation.bytes) || observation.bytes < 0 ||
    !SETUP_REPOSITORY_REASONS.includes(observation.observedReason)) {
    throw new Error("repository candidate observation is invalid");
  }
  const reason = canonicalReason(observation);
  const candidate = Object.freeze({
    path: observation.path,
    kind: observation.kind,
    bytes: observation.bytes,
    tracking: observation.tracking,
    disposition: canonicalDisposition({ ...observation, reason }),
    reason,
  });
  validateCanonicalReason(candidate);
  if (!observation.gitDirect && (candidate.tracking === "tracked" || candidate.tracking === "untracked")) {
    throw new Error("repository candidate tracking disagrees with repository boundary");
  }
  return candidate;
}

/** Validate an injected/public tuple by recomputing every derivable decision. */
export function validateSetupRepositoryCandidate(
  candidate: SetupRepositoryCandidate,
  gitDirect: boolean,
): void {
  const derived = deriveSetupRepositoryCandidate({
    path: candidate.path,
    kind: candidate.kind,
    bytes: candidate.bytes,
    tracking: candidate.tracking,
    gitDirect,
    observedReason: candidate.reason,
  });
  if (JSON.stringify(derived) !== JSON.stringify(candidate)) {
    throw new Error("repository candidate disagrees with canonical policy");
  }
}

export function sensitiveRepositoryPath(path: string): boolean {
  const parts = path.split("/").map((part) => part.toLowerCase());
  return parts.some((part) =>
    part === ".env" || /^[.]env(?:[._-]|rc(?:[._-]|$))/.test(part) ||
    /(?:^|[._-])(credential|credentials|secret|secrets|token|tokens|password|passwd|private[._-]?key)(?:[._-]|$)/i.test(part)
  ) || /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key|keystore))$/i.test(parts.at(-1)!);
}

export function privateCaseAliasPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) => {
    const lower = part.toLowerCase();
    return (lower === ".dome" || lower === ".git") && part !== lower;
  }) || parts.some((part, index) => part.toLowerCase() === ".dome" &&
    parts[index + 1]?.toLowerCase() === "state" && parts[index + 1] !== "state");
}

export function domePrivateRepositoryPath(path: string): boolean {
  return path === ".dome/state" || path.startsWith(".dome/state/");
}

export function nestedGitControlPath(path: string): boolean {
  return path.split("/").slice(1).some((part) => part === ".git");
}

export function symlinkRepositoryReason(path: string, target: string): "symlink-internal" | "symlink-external" {
  if (target.startsWith("/")) return "symlink-external";
  const normalized = posix.normalize(posix.join(posix.dirname(path), target));
  return normalized === ".." || normalized.startsWith("../") ? "symlink-external" : "symlink-internal";
}

function canonicalReason(observation: SetupRepositoryObservation): SetupRepositoryCandidate["reason"] {
  if (privateCaseAliasPath(observation.path)) return "private-case-alias";
  if (nestedGitControlPath(observation.path)) return "nested-repository";
  if (domePrivateRepositoryPath(observation.path)) return "dome-private";
  if (["symlink-internal", "symlink-external", "special-file", "hard-linked-file"].includes(
    observation.observedReason,
  )) return observation.observedReason;
  if (sensitiveRepositoryPath(observation.path)) return "sensitive-name";
  if (observation.tracking === "ignored") return "ignored-by-owner";
  return observation.observedReason;
}

function canonicalDisposition(
  observation: SetupRepositoryObservation & Readonly<{ reason: SetupRepositoryCandidate["reason"] }>,
): SetupRepositoryCandidate["disposition"] {
  if (observation.kind === "symlink" || observation.kind === "special" ||
    observation.reason === "nested-repository" || observation.reason === "hard-linked-file" ||
    observation.reason === "private-case-alias" ||
    (observation.path === ".dome/state" && observation.kind !== "directory")) return "blocked";
  if (observation.tracking === "tracked") return "already-tracked";
  if (!observation.gitDirect && observation.kind === "file" && observation.reason === "safe-owner-file" &&
    (observation.tracking === "other" || observation.tracking === "untracked")) return "baseline";
  return "preserve-untracked";
}

function validateCanonicalReason(candidate: SetupRepositoryCandidate): void {
  const invalid = (() => {
    switch (candidate.reason) {
      case "safe-owner-file": return candidate.kind !== "file" ||
        candidate.bytes > SETUP_REPOSITORY_MAX_BASELINE_FILE_BYTES || sensitiveRepositoryPath(candidate.path) ||
        domePrivateRepositoryPath(candidate.path) || nestedGitControlPath(candidate.path) || privateCaseAliasPath(candidate.path);
      case "directory-not-tracked": return candidate.kind !== "directory";
      case "ignored-by-owner": return candidate.tracking !== "ignored";
      case "sensitive-name": return !sensitiveRepositoryPath(candidate.path);
      case "large-file": return candidate.kind !== "file";
      case "nested-repository": return !nestedGitControlPath(candidate.path);
      case "symlink-internal":
      case "symlink-external": return candidate.kind !== "symlink";
      case "special-file": return candidate.kind !== "special";
      case "hard-linked-file": return candidate.kind !== "file";
      case "dome-private": return !domePrivateRepositoryPath(candidate.path);
      case "private-case-alias": return !privateCaseAliasPath(candidate.path);
    }
  })();
  if (invalid) throw new Error("repository candidate reason disagrees with inspected facts");
}

function safeRepositoryPath(path: string): boolean {
  return path !== "" && !path.startsWith("/") && !path.includes("\\") && !/[\u0000-\u001f\u007f]/.test(path) &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
