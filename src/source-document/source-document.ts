// Exact adopted-source reader: one small Interface hides adopted-ref lookup,
// ancestry enforcement, path canonicality, git reads, and response bounds.

import {
  SOURCE_DOCUMENT_SCHEMA,
  type SourceDocumentResult,
} from "../../contracts/source-document";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import { parseVaultPath } from "../core/vault-path";
import { blobSizeAtCommit, probeAncestry, readBlob } from "../git";

export const DEFAULT_SOURCE_DOCUMENT_MAX_BYTES = 512 * 1024;

export type ReadSourceDocumentInput = {
  readonly vaultPath: string;
  readonly path: string;
  readonly commit: string;
  readonly maxBytes?: number | undefined;
};

export type SourceDocumentReaderDependencies = {
  readonly getCurrentBranch: typeof getCurrentBranch;
  readonly getAdoptedRef: typeof getAdoptedRef;
  readonly probeAncestry: typeof probeAncestry;
  readonly blobSizeAtCommit: typeof blobSizeAtCommit;
  readonly readBlob: typeof readBlob;
};

const DEFAULT_DEPENDENCIES: SourceDocumentReaderDependencies = Object.freeze({
  getCurrentBranch,
  getAdoptedRef,
  probeAncestry,
  blobSizeAtCommit,
  readBlob,
});

export async function readSourceDocument(
  input: ReadSourceDocumentInput,
  dependencies: SourceDocumentReaderDependencies = DEFAULT_DEPENDENCIES,
): Promise<SourceDocumentResult> {
  const parsedPath = parseVaultPath(input.path);
  if (!parsedPath.ok || parsedPath.path !== input.path) {
    return problem("invalid-path", "path must be a canonical vault-relative POSIX file path");
  }
  if (
    /[\x00-\x1f\x7f]/.test(input.path) ||
    !input.path.endsWith(".md") ||
    input.path === ".dome" || input.path.startsWith(".dome/") ||
    input.path === ".git" || input.path.startsWith(".git/")
  ) {
    return problem("invalid-path", "source path must name user-owned Markdown outside engine metadata");
  }
  if (!/^[0-9a-f]{40}$/i.test(input.commit)) {
    return problem("invalid-commit", "commit must be a full 40-character Git object id");
  }
  const maxBytes = input.maxBytes ?? DEFAULT_SOURCE_DOCUMENT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("readSourceDocument maxBytes must be a positive safe integer");
  }

  try {
    const branch = await dependencies.getCurrentBranch(input.vaultPath);
    if (branch === null) {
      return problem("unavailable", "the vault has no current branch");
    }
    const adopted = await dependencies.getAdoptedRef(input.vaultPath, branch);
    if (adopted === null) {
      return problem("unavailable", "the current branch has no adopted commit");
    }

  // A citation may point at the current adopted commit or any commit retained
  // in its ancestry. Unreachable objects and future/unadopted
  // commits are never readable through this Interface.
    // The git adapters' descendent predicate is strict on some backends, so
    // current adopted equality is handled explicitly before ancestry.
    if (input.commit.toLowerCase() !== adopted.toLowerCase()) {
      const ancestry = await dependencies.probeAncestry({
        path: input.vaultPath,
        ancestor: input.commit,
        descendant: adopted,
      });
      if (ancestry.kind === "unavailable") {
        return problem("unavailable", "the cited source is temporarily unavailable");
      }
      if (ancestry.kind === "not-ancestor") {
        return problem("not-adopted", "the cited commit is not in current adopted history");
      }
    }

    const blobSize = await dependencies.blobSizeAtCommit({
      path: input.vaultPath,
      commit: input.commit,
      filepath: parsedPath.path,
    });
    if (blobSize === null) {
      return problem("not-found", "the cited path does not exist at that adopted commit");
    }
    if (blobSize > maxBytes) {
      return problem("too-large", `source document exceeds the ${maxBytes}-byte response limit`);
    }

    const content = await dependencies.readBlob({
      path: input.vaultPath,
      commit: input.commit,
      filepath: parsedPath.path,
    });
    if (content === null) {
      return problem("not-found", "the cited path does not exist at that adopted commit");
    }
    // Defend against a repository changing between metadata and content reads.
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      return problem("too-large", `source document exceeds the ${maxBytes}-byte response limit`);
    }
    return Object.freeze({
      schema: SOURCE_DOCUMENT_SCHEMA,
      status: "ok" as const,
      path: parsedPath.path,
      commit: input.commit.toLowerCase(),
      content,
    });
  } catch {
    return problem("unavailable", "the cited source is temporarily unavailable");
  }
}

function problem(
  status: Exclude<SourceDocumentResult["status"], "ok">,
  message: string,
): SourceDocumentResult {
  return Object.freeze({ schema: SOURCE_DOCUMENT_SCHEMA, status, message });
}
