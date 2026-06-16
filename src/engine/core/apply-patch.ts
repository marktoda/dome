// apply-patch: the candidate-tree mutator for adoption-phase PatchEffects.
//
// Given the current candidate commit OID + a PatchEffect's whole-content
// `changes` list, this function produces a new candidate commit OID when the
// patch changes the candidate tree. Same-tree patches return `null`. The
// working tree is never read or written; everything goes through
// isomorphic-git plumbing (`writeBlob` / `readTree` / `writeTree` /
// `writeCommit`). That isolation lets the daemon advance the candidate even
// while the user has uncommitted edits in `<vault>/`.
//
// Each tree-moving PatchEffect produces one commit. The adoption loop
// accumulates a chain of these commits as the candidate; the final candidate
// OID becomes the new value of `refs/dome/adopted/<branch>` (Decision 6 in
// v1.x Phase 12a). The commit carries the four `Dome-*` trailers per
// ENGINE_COMMITS_CARRY_DOME_TRAILERS via `composeCommitMessage` from
// `../engine-commit`.
//
// Normative references:
//   - docs/wiki/specs/effects.md §"PatchEffect" — the effect shape.
//   - docs/wiki/specs/adoption.md §"The fixed-point adoption loop" — the
//     `candidate = apply_patches(candidate, patches)` step this implements.
//   - docs/wiki/invariants/ENGINE_COMMITS_CARRY_DOME_TRAILERS.md — the four
//     trailers each engine commit carries.
//
// Failure modes:
//   - Empty `changes` array (caught structurally by `PatchEffectSchema`'s
//     `.min(1)`; defensive `null` return here as belt-and-braces).
//   - Git-level errors (corrupt object, disk full, write failure) throw —
//     operator/programmer-level issues the adoption loop does not attempt
//     to recover from.
//
// A write is applied as a 3-way merge when `runContext.mergeBase` is set and
// differs from `candidate`: the emitting processor's read-snapshot is the
// merge base, the already-landed candidate blob is `ours`, and the write's
// content is `theirs`. Disjoint regions compose; a conflicting region resolves
// to `ours` (the already-landed change, never reverted) and fires
// `onMergeConflict`. An absent or `=== candidate` mergeBase is a plain
// overwrite (the common case, byte-identical to pre-merge behavior). Deletes
// are no-ops when the path doesn't exist in the candidate's tree. If all
// writes/deletes collapse to the same root tree OID, no commit is written.
// There is no "patch failed to apply" path — a merge always produces a blob.
//
// House-style notes (matches src/engine/core/closure-commit.ts,
// src/engine/core/apply-effect.ts, src/engine/core/compile-range.ts):
//   - Banner cites the normative spec + invariant.
//   - Imports limited to isomorphic-git (the engine layer's git boundary
//     callout — same exception closure-commit.ts carries), Node `fs`
//     (isomorphic-git fs client), `node:path` for POSIX joins,
//     `../engine-commit` (the trailer composer), and pure types from
//     `../core/`.
//   - `type X = { ... }` for the public input shape; every field `readonly`.

import fs from "node:fs";
import { posix } from "node:path";

import git from "isomorphic-git";

import type { PatchEffect } from "../../core/effect";
import { commitOid, type CommitOid } from "../../core/source-ref";
import { requireVaultPath } from "../../core/vault-path";
import { composeCommitMessage } from "../../engine-commit";
import { findGitRoot } from "../../git";
import { merge3 } from "./diff3";

// ----- ApplyPatchInput ------------------------------------------------------

/**
 * The per-effect context the adoption loop hands to `applyPatchToCandidate`.
 * `runContext` carries the four trailer fields (Dome-Run / Dome-Extension /
 * Dome-Base / Dome-Source-Head) the engine stamps on every commit it makes;
 * `extensionId` is derived by the caller from the originating `processorId`
 * (the bundle prefix, e.g., `dome.markdown` from `dome.markdown.normalize`).
 */
export type ApplyPatchInput = {
  readonly vaultPath: string;
  readonly candidate: CommitOid;
  readonly patch: PatchEffect;
  readonly runContext: {
    readonly runId: string;
    readonly processorId: string;
    readonly extensionId: string;
    /** `refs/dome/adopted/<branch>` SHA at loop start. */
    readonly base: CommitOid;
    /** HEAD SHA at loop start. */
    readonly sourceHead: CommitOid;
    /**
     * The commit the emitting processor READ (its input snapshot), used as the
     * 3-way merge base when `candidate` has advanced past it (a sibling patch
     * landed in between). Absent or `=== candidate` → plain overwrite (no
     * sibling divergence to reconcile). Distinct from `base` (the Dome-Base
     * trailer / `proposal.base`), which must stay equal to the new commit's
     * parent. See docs/cohesive/brainstorms/2026-06-16-garden-patch-3way-merge.md.
     */
    readonly mergeBase?: CommitOid;
  };
  readonly now?: () => Date;
  /** Called once per write whose 3-way merge had a true conflict (resolved to `ours`). */
  readonly onMergeConflict?: (info: { readonly path: string; readonly processorId: string }) => void;
};

// ----- applyPatchToCandidate ------------------------------------------------

/**
 * Apply a PatchEffect's `changes` to a candidate commit's tree without
 * touching the working tree. Returns the new candidate's commit OID on
 * success, `null` on the (defensive) empty-changes case.
 *
 * The new commit carries the four `Dome-*` trailers; its subject line is
 * `engine(applyPatch): <processorId>`. The parent is the input candidate.
 * The author + committer are the engine identity (`dome / engine@dome.local`)
 * — consistent with the closure-commit author per
 * src/engine-commit.ts §"author default".
 */
export async function applyPatchToCandidate(
  opts: ApplyPatchInput,
): Promise<CommitOid | null> {
  // Defense in depth: PatchEffectSchema enforces `changes.min(1)` at the
  // boundary, but the constructor `patchEffect()` is unvalidated (per the
  // file-level house-style note). A direct call with an empty list would
  // produce a same-tree commit, which is structurally meaningless. Refuse.
  if (opts.patch.changes.length === 0) return null;

  // 1. Resolve the git root once. `vaultPath` may sit inside an outer git
  //    repo (the dogfood case where docs/ lives inside the SDK repo); the
  //    engine's plumbing operates against the outer root and uses the
  //    POSIX-joined prefix for path translation.
  const root = await findGitRoot(opts.vaultPath);
  if (root === null) {
    throw new Error(
      `applyPatchToCandidate: vault path is not inside a git repo: ${opts.vaultPath}`,
    );
  }
  const prefix = computePrefix(root, opts.vaultPath);

  // 2. Walk the changes list: for writes, hash the new content into the
  //    object database; for deletes, accumulate paths to remove. The
  //    `writes` map and `deletes` set are keyed by outer-repo-relative
  //    path (vault-path → prefix-joined) so the tree-rebuild step sees a
  //    single coherent path namespace.
  const writes = new Map<string, string>(); // outer-repo path → new blob oid
  const deletes = new Set<string>();

  for (const change of opts.patch.changes) {
    const vaultPath = requireVaultPath(change.path, "PatchEffect.change.path");
    const fullPath = joinPrefix(prefix, vaultPath);
    if (change.kind === "write") {
      let finalContent = change.content;
      const mergeBase = opts.runContext.mergeBase;
      // Only reconcile when a sibling advanced the candidate past the snapshot
      // the processor read. Same-commit (or unset) mergeBase → overwrite, the
      // common case and byte-identical to pre-merge behavior.
      if (mergeBase !== undefined && mergeBase !== opts.candidate) {
        const ours = await readBlobUtf8(root, opts.candidate, fullPath);
        const baseContent = await readBlobUtf8(root, mergeBase, fullPath);
        if (ours !== null && ours !== baseContent) {
          const m = merge3({
            base: baseContent ?? "",
            ours,
            theirs: change.content,
          });
          finalContent = m.text;
          if (m.conflict) {
            opts.onMergeConflict?.({
              path: change.path,
              processorId: opts.runContext.processorId,
            });
          }
        }
      }
      const blobOid = await git.writeBlob({
        fs,
        dir: root,
        blob: Buffer.from(finalContent, "utf8"),
      });
      writes.set(fullPath, blobOid);
      // A later write supersedes an earlier delete of the same path.
      deletes.delete(fullPath);
    } else {
      deletes.add(fullPath);
      // A later delete supersedes an earlier write of the same path.
      writes.delete(fullPath);
    }
  }

  // 3. Rebuild the candidate tree with the writes/deletes overlaid. The
  //    rewrite is purely additive at the object-database level — the new
  //    tree OID is the only ref-targetable surface.
  const candidateCommit = await git.readCommit({
    fs,
    dir: root,
    oid: opts.candidate,
  });
  const oldRootTreeOid = candidateCommit.commit.tree;

  const treeChanges: TreeChange[] = [];
  for (const [path, blobOid] of writes) {
    treeChanges.push({ kind: "write", path, blobOid });
  }
  for (const path of deletes) {
    treeChanges.push({ kind: "delete", path });
  }

  const newRootTreeOid = await rebuildTreeWithChanges({
    root,
    treeOid: oldRootTreeOid,
    changes: treeChanges,
  });
  if (newRootTreeOid === oldRootTreeOid) {
    return null;
  }

  // 4. Write the new commit. `writeCommit` accepts a CommitObject directly —
  //    we don't go through `git.commit` because that path requires staging
  //    via the index, which would touch the working tree.
  const body = commitBodyFromReason(opts.patch.reason);
  const message = composeCommitMessage({
    verb: "engine(applyPatch)",
    subject: opts.runContext.processorId,
    ...(body !== undefined ? { body } : {}),
    touchedPaths: [], // unused by composeCommitMessage when only verb/subject are set
    runContext: {
      runId: opts.runContext.runId,
      extensionId: opts.runContext.extensionId,
      base: opts.runContext.base,
      sourceHead: opts.runContext.sourceHead,
    },
  });

  const committedAt = opts.now?.() ?? new Date();
  const now = Math.floor(committedAt.getTime() / 1000);
  const identity = {
    name: "dome",
    email: "engine@dome.local",
    timestamp: now,
    timezoneOffset: 0,
  } as const;

  const newCommitOid = await git.writeCommit({
    fs,
    dir: root,
    commit: {
      message,
      tree: newRootTreeOid,
      parent: [opts.candidate],
      author: identity,
      committer: identity,
    },
  });

  return commitOid(newCommitOid);
}

/**
 * The PatchEffect's `reason` is the narrative activity log (NO_ACCRETING_REGISTRIES:
 * git history replaces log.md). Bound and sanitize: single paragraph, no
 * trailer-spoofing `Key: value` line starts, hard cap to keep messages sane.
 */
const REASON_BODY_MAX_CHARS = 600;
function commitBodyFromReason(reason: string): string | undefined {
  const flat = reason.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return undefined;
  return flat.slice(0, REASON_BODY_MAX_CHARS);
}

// ----- tree rebuild ---------------------------------------------------------

type TreeChange =
  | { readonly kind: "write"; readonly path: string; readonly blobOid: string }
  | { readonly kind: "delete"; readonly path: string };

/**
 * Rebuild a tree with the given path-level changes applied. Walks the tree
 * recursively from the root, grouping changes by their first path segment.
 * Each subtree is rewritten with its own changes; leaf changes (no remaining
 * path segments) write/delete blobs in the current tree. Returns the new
 * root tree OID.
 *
 * The rewrite is purely additive at the object-database level — old objects
 * stay reachable from `refs/dome/adopted/<branch>`'s prior value until git
 * gc runs. The new tree's OID is the only new ref-targetable surface.
 */
async function rebuildTreeWithChanges(opts: {
  readonly root: string;
  readonly treeOid: string;
  readonly changes: ReadonlyArray<TreeChange>;
}): Promise<string> {
  const { root, treeOid, changes } = opts;

  // Group changes by first path segment. Leaf changes (path with no `/`)
  // are applied to the current tree; nested changes recurse into subtrees.
  const leafWrites = new Map<string, string>(); // name -> blob oid
  const leafDeletes = new Set<string>();
  const subtreeChanges = new Map<string, TreeChange[]>(); // dir -> nested

  for (const change of changes) {
    const segments = change.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    if (segments.length === 1) {
      const name = segments[0] as string;
      if (change.kind === "write") {
        leafWrites.set(name, change.blobOid);
        leafDeletes.delete(name);
      } else {
        leafDeletes.add(name);
        leafWrites.delete(name);
      }
      continue;
    }
    const [head, ...rest] = segments;
    if (head === undefined) continue;
    const restPath = rest.join("/");
    const nested: TreeChange =
      change.kind === "write"
        ? { kind: "write", path: restPath, blobOid: change.blobOid }
        : { kind: "delete", path: restPath };
    const existing = subtreeChanges.get(head);
    if (existing === undefined) subtreeChanges.set(head, [nested]);
    else existing.push(nested);
  }
  assertNoFileDirectoryCollisions({
    leafNames: new Set([...leafWrites.keys(), ...leafDeletes]),
    subtreeNames: new Set(subtreeChanges.keys()),
  });

  // Read the current tree's entries.
  const current = await git.readTree({ fs, dir: root, oid: treeOid });

  // Build the new tree entries: start from the existing entries, apply
  // deletes, override blob writes, and replace subtrees with their
  // recursively-rewritten OIDs.
  const newEntries: typeof current.tree = [];

  // Track names handled via leafWrites/subtreeChanges so we know which
  // existing entries to drop or carry forward.
  const handled = new Set<string>();

  for (const entry of current.tree) {
    if (leafDeletes.has(entry.path)) {
      handled.add(entry.path);
      continue;
    }
    if (leafWrites.has(entry.path)) {
      if (entry.type === "tree") {
        throw pathCollisionError(entry.path, "write-file-over-directory");
      }
      const blobOid = leafWrites.get(entry.path);
      if (blobOid === undefined) continue;
      newEntries.push({
        mode: entry.type === "blob" ? entry.mode : "100644",
        path: entry.path,
        oid: blobOid,
        type: "blob",
      });
      handled.add(entry.path);
      continue;
    }
    if (subtreeChanges.has(entry.path)) {
      if (entry.type !== "tree") {
        throw pathCollisionError(entry.path, "write-under-file");
      }
      const nested = subtreeChanges.get(entry.path);
      if (nested === undefined) continue;
      const newSubOid = await rebuildTreeWithChanges({
        root,
        treeOid: entry.oid,
        changes: nested,
      });
      newEntries.push({
        mode: "040000",
        path: entry.path,
        oid: newSubOid,
        type: "tree",
      });
      handled.add(entry.path);
      continue;
    }
    newEntries.push(entry);
  }

  // Leaf writes for paths that don't yet exist in this tree (file creation).
  for (const [name, blobOid] of leafWrites) {
    if (handled.has(name)) continue;
    newEntries.push({
      mode: "100644",
      path: name,
      oid: blobOid,
      type: "blob",
    });
  }

  // Subtree changes for directories that don't yet exist (mkdir + file).
  for (const [name, nested] of subtreeChanges) {
    if (handled.has(name)) continue;
    const newSubOid = await buildTreeFromScratch({ root, changes: nested });
    if (newSubOid === null) continue;
    newEntries.push({
      mode: "040000",
      path: name,
      oid: newSubOid,
      type: "tree",
    });
  }

  // Sort entries by name — git's canonical tree layout. `writeTree` is
  // tolerant of order, but matching git's expectation keeps OIDs stable
  // across re-runs against the same logical inputs.
  newEntries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return git.writeTree({ fs, dir: root, tree: newEntries });
}

/**
 * Build a new tree from scratch for the case where the change describes a
 * directory that doesn't exist in the candidate's tree (e.g., a write to
 * `wiki/new-dir/page.md`). Returns null if all nested changes are deletes
 * (nothing to create — deletes against a nonexistent path are no-ops).
 */
async function buildTreeFromScratch(opts: {
  readonly root: string;
  readonly changes: ReadonlyArray<TreeChange>;
}): Promise<string | null> {
  const { root, changes } = opts;
  const leafWrites = new Map<string, string>();
  const subtreeChanges = new Map<string, TreeChange[]>();

  for (const change of changes) {
    if (change.kind === "delete") continue; // nothing to delete in a fresh tree
    const segments = change.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    if (segments.length === 1) {
      leafWrites.set(segments[0] as string, change.blobOid);
      continue;
    }
    const [head, ...rest] = segments;
    if (head === undefined) continue;
    const nested: TreeChange = {
      kind: "write",
      path: rest.join("/"),
      blobOid: change.blobOid,
    };
    const existing = subtreeChanges.get(head);
    if (existing === undefined) subtreeChanges.set(head, [nested]);
    else existing.push(nested);
  }
  assertNoFileDirectoryCollisions({
    leafNames: new Set(leafWrites.keys()),
    subtreeNames: new Set(subtreeChanges.keys()),
  });

  if (leafWrites.size === 0 && subtreeChanges.size === 0) return null;

  const entries: Array<{
    mode: string;
    path: string;
    oid: string;
    type: "commit" | "blob" | "tree";
  }> = [];

  for (const [name, blobOid] of leafWrites) {
    entries.push({ mode: "100644", path: name, oid: blobOid, type: "blob" });
  }
  for (const [name, nested] of subtreeChanges) {
    const subOid = await buildTreeFromScratch({ root, changes: nested });
    if (subOid === null) continue;
    entries.push({ mode: "040000", path: name, oid: subOid, type: "tree" });
  }

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return git.writeTree({ fs, dir: root, tree: entries });
}

function assertNoFileDirectoryCollisions(input: {
  readonly leafNames: ReadonlySet<string>;
  readonly subtreeNames: ReadonlySet<string>;
}): void {
  for (const name of input.leafNames) {
    if (input.subtreeNames.has(name)) {
      throw pathCollisionError(name, "same-patch-file-and-directory");
    }
  }
}

function pathCollisionError(
  path: string,
  kind:
    | "same-patch-file-and-directory"
    | "write-file-over-directory"
    | "write-under-file",
): Error {
  return new Error(
    `applyPatchToCandidate: file/directory path collision at '${path}' (${kind}).`,
  );
}

// ----- path helpers ---------------------------------------------------------

/**
 * Compute the prefix (POSIX-normalized relative path from `root` to
 * `vaultPath`) used to translate vault-relative filepaths into outer-repo-
 * relative paths for isomorphic-git. Returns `""` when the vault is the
 * git root itself.
 */
function computePrefix(root: string, vaultPath: string): string {
  if (root === vaultPath) return "";
  // Resolve both to absolute then take the relative path. `vaultPath` may
  // not be a clean prefix of `root` on case-insensitive filesystems; this
  // is the same conservative form `src/git.ts:resolveGitContext` uses.
  const rel = vaultPath.startsWith(root + "/")
    ? vaultPath.slice(root.length + 1)
    : vaultPath;
  return rel.split(/[\\/]/).filter((s) => s.length > 0).join("/");
}

/**
 * POSIX-join the (optional) prefix with a vault-relative path. Returns the
 * vault-relative path unchanged when prefix is empty (the standalone-vault
 * case where `.git/` sits at the vault root).
 */
function joinPrefix(prefix: string, vaultPath: string): string {
  return prefix === "" ? vaultPath : posix.join(prefix, vaultPath);
}

/** Read a file's UTF-8 content at a commit; `null` when the path is absent there. */
async function readBlobUtf8(
  root: string,
  oid: string,
  filepath: string,
): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir: root, oid, filepath });
    return Buffer.from(blob).toString("utf8");
  } catch (e) {
    if (e instanceof git.Errors.NotFoundError) return null;
    throw e;
  }
}
