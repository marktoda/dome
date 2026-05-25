import git from "isomorphic-git";
import fs from "node:fs";
import type { Vault } from "./vault";

export interface WorkflowCommitInput {
  verb: string;
  subject: string;
  body?: string;
  touchedPaths: ReadonlyArray<string>;
  author?: { name: string; email: string };
}

/**
 * Per-workflow atomic git commit. Stages every touched path and creates a
 * single commit whose subject is `<verb>: <subject>`.
 *
 * Returns the commit SHA, or "" when the vault has disabled
 * `git.auto_commit_workflows`. The caller is responsible for having driven all
 * Tool effects to the working tree prior to this call.
 */
export async function commitWorkflow(vault: Vault, input: WorkflowCommitInput): Promise<string> {
  if (!vault.config.git.auto_commit_workflows) {
    return ""; // commit skipped; caller may still log
  }
  for (const p of input.touchedPaths) {
    try {
      await git.add({ fs, dir: vault.path, filepath: p });
    } catch {
      // Ignore add-failure for paths that may have been deleted; git.commit
      // will still capture deletions present in the index.
    }
  }
  const message = input.body
    ? `${input.verb}: ${input.subject}\n\n${input.body}`
    : `${input.verb}: ${input.subject}`;
  const author = input.author ?? { name: "Dome", email: "dome@local" };
  return git.commit({ fs, dir: vault.path, message, author });
}
