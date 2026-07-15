// surface/recents: collector for the "recently-touched knowledge pages" panel.
//
// Runtime-free read surface (mirrors activity.ts posture): no lock, no
// Proposal, read-only over git history. Deduplicates by path so each page
// appears at most once — at the timestamp of its most-recent commit.
//
// Knowledge-page filter: wiki/entities/, wiki/concepts/, wiki/sources/,
// wiki/syntheses/, notes/ — markdown files only. Dailies and loose root
// files (index.md, etc.) are excluded.

import matter from "gray-matter";
import { getAdoptedRef, getCurrentBranch } from "../adopted-ref";
import { changedPathsForCommit, logWithTrailers, readBlob } from "../git";
import { resolveVaultPath } from "./resolve-vault";

/** Default number of entries when the caller does not pass `limit`. */
const DEFAULT_LIMIT = 20;

/** How many commits to walk before giving up on filling `limit`. */
const COMMIT_SCAN_CAP = 400;

// ----- Public types ----------------------------------------------------------

export type RecentEntry = {
  /** Vault-relative path, e.g. `wiki/entities/foo.md`. */
  readonly path: string;
  /** Human-readable title: frontmatter `description` > first `#` heading > basename. */
  readonly title: string;
  /** ISO-8601 committer timestamp of the most-recent change. */
  readonly lastChangedAt: string;
  /** "engine" iff the commit carries a non-empty Dome-Run trailer. */
  readonly changedBy: "human" | "engine";
  /** Commit subject line. */
  readonly subject: string;
  /** Exact newest-change commit in the current branch's adopted ancestry. */
  readonly commit: string;
};

// ----- Knowledge-page predicate ----------------------------------------------

const INCLUDE_PREFIXES = [
  "wiki/entities/",
  "wiki/concepts/",
  "wiki/sources/",
  "wiki/syntheses/",
  "notes/",
];

function isKnowledgePage(p: string): boolean {
  if (!p.endsWith(".md")) return false;
  if (p.startsWith("wiki/dailies/")) return false;
  return INCLUDE_PREFIXES.some((pre) => p.startsWith(pre));
}

// ----- Title resolution ------------------------------------------------------

async function titleFor(vault: string, commitSha: string, path: string): Promise<string> {
  const basename = path.split("/").pop() ?? path;
  const blob = await readBlob({ path: vault, commit: commitSha, filepath: path }).catch(
    () => null,
  );
  if (blob === null) return basename;
  // readBlob returns string | null — already UTF-8 decoded
  try {
    const fm = matter(blob);
    const desc = fm.data?.["description"];
    if (typeof desc === "string" && desc.trim().length > 0) return desc.trim();
    const heading = fm.content.split("\n").find((l) => l.startsWith("# "));
    if (heading !== undefined) return heading.replace(/^#\s+/, "").trim();
  } catch {
    /* fall through to basename */
  }
  return basename;
}

// ----- buildRecents ----------------------------------------------------------

/**
 * Collect recently-touched knowledge pages for a vault, newest-first,
 * deduped so each page appears at most once (its most-recent change wins).
 */
export async function buildRecents(
  options: { readonly vault?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<ReadonlyArray<RecentEntry>> {
  const vault = resolveVaultPath(options.vault);
  const limit = options.limit ?? DEFAULT_LIMIT;
  const branch = await getCurrentBranch(vault);
  if (branch === null) return Object.freeze([]);
  const adopted = await getAdoptedRef(vault, branch);
  if (adopted === null) return Object.freeze([]);

  const commits = await logWithTrailers({ path: vault, limit: COMMIT_SCAN_CAP, ref: adopted });
  const seen = new Set<string>();
  const out: RecentEntry[] = [];

  // Perf note: one `changedPathsForCommit` subprocess per commit (up to COMMIT_SCAN_CAP).
  // Acceptable for a low-frequency single-user panel. Follow-up: collapse to a single
  // `git log --name-only` with a roots pathspec (the `latestFileInfoByPath` pattern in
  // src/git.ts) if this loop ever becomes hot.
  for (const commit of commits) {
    if (out.length >= limit) break;
    const paths = await changedPathsForCommit({ path: vault, sha: commit.sha });
    for (const p of paths) {
      if (out.length >= limit) break;
      if (!isKnowledgePage(p) || seen.has(p)) continue;
      seen.add(p);
      out.push(
        Object.freeze({
          path: p,
          title: await titleFor(vault, commit.sha, p),
          lastChangedAt: commit.at,
          changedBy: commit.domeRun === null ? ("human" as const) : ("engine" as const),
          subject: commit.subject,
          commit: commit.sha,
        }),
      );
    }
  }

  return Object.freeze(out);
}
