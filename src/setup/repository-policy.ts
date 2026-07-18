/** Content-free repository inventory vocabulary shared by inspection and setup contracts. */
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
] as const;

export type SetupRepositoryCandidate = Readonly<{
  path: string;
  kind: typeof SETUP_REPOSITORY_CANDIDATE_KINDS[number];
  bytes: number;
  tracking: "tracked" | "untracked" | "ignored" | "other";
  disposition: typeof SETUP_REPOSITORY_DISPOSITIONS[number];
  reason: typeof SETUP_REPOSITORY_REASONS[number];
}>;
