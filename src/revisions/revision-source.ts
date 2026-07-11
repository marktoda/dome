// revisions/revision-source: one process-lifetime source for immutable Git
// revisions. It owns tree traversal, blob reads, bounded caches, and diff
// signal synthesis so compile-range, processor snapshots, and projection
// rebuild do not each reconstruct the same revision independently.

import { posix, resolve } from "node:path";

import { treeOid, type Signal, type Snapshot, type SnapshotFileInfo, type TreeOid } from "../core/processor";
import { commitOid, type CommitOid } from "../core/source-ref";
import { fileInfoAtCommit, readBlobByOid, readTree } from "../git";

export type SignalEvent = {
  readonly signal: Signal;
  readonly path: string;
};

export type CompileRangeResult = {
  readonly changedPaths: ReadonlyArray<string>;
  readonly addedPaths: ReadonlyArray<string>;
  readonly modifiedPaths: ReadonlyArray<string>;
  readonly deletedPaths: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<SignalEvent>;
};

export type Revision = {
  readonly commit: CommitOid;
  readonly tree: TreeOid;
  paths(): Promise<ReadonlyArray<string>>;
  readonly snapshot: Snapshot;
};

export type RevisionSourceMetrics = {
  readonly treeLoads: number;
  readonly treeHits: number;
  readonly manifestLoads: number;
  readonly manifestHits: number;
  readonly blobLoads: number;
  readonly blobHits: number;
};

export type RevisionSource = {
  revision(
    commit: CommitOid,
    resolveTree?: (commit: CommitOid) => Promise<TreeOid>,
  ): Promise<Revision>;
  diff(base: CommitOid, head: CommitOid): Promise<CompileRangeResult>;
  metrics(): RevisionSourceMetrics;
};

type ManifestEntry = {
  readonly oid: string;
  readonly type: string;
};

const MAX_SOURCES = 8;
const MAX_REVISIONS = 24;
const MAX_TREES = 32;
const MAX_BLOBS = 1_024;
const sources = new Map<string, RevisionSource>();

export function revisionSourceFor(vaultPath: string): RevisionSource {
  const key = resolve(vaultPath);
  const existing = sources.get(key);
  if (existing !== undefined) {
    touch(sources, key, existing);
    return existing;
  }
  const source = createRevisionSource(key);
  setBounded(sources, key, source, MAX_SOURCES);
  return source;
}

export function createRevisionSource(vaultPath: string): RevisionSource {
  const revisions = new Map<string, Promise<Revision>>();
  const treeByCommit = new Map<string, Promise<TreeOid>>();
  const manifestByTree = new Map<string, Promise<ReadonlyMap<string, ManifestEntry>>>();
  const blobs = new Map<string, Promise<string | null>>();
  const counters = {
    treeLoads: 0,
    treeHits: 0,
    manifestLoads: 0,
    manifestHits: 0,
    blobLoads: 0,
    blobHits: 0,
  };

  const treeFor = (
    commit: CommitOid,
    injected?: (commit: CommitOid) => Promise<TreeOid>,
  ): Promise<TreeOid> => {
    const cached = treeByCommit.get(commit);
    if (cached !== undefined) {
      counters.treeHits += 1;
      touch(treeByCommit, commit, cached);
      return cached;
    }
    counters.treeLoads += 1;
    const loaded = injected === undefined
      ? readTree({ path: vaultPath, oid: commit }).then((result) => treeOid(result.oid))
      : injected(commit);
    return cachePromise(treeByCommit, commit, loaded, MAX_REVISIONS);
  };

  const manifestFor = async (
    commit: CommitOid,
    injected?: (commit: CommitOid) => Promise<TreeOid>,
  ): Promise<ReadonlyMap<string, ManifestEntry>> => {
    const tree = await treeFor(commit, injected);
    const cached = manifestByTree.get(tree);
    if (cached !== undefined) {
      counters.manifestHits += 1;
      touch(manifestByTree, tree, cached);
      return cached;
    }
    counters.manifestLoads += 1;
    const loaded = loadManifest(vaultPath, tree);
    return cachePromise(manifestByTree, tree, loaded, MAX_TREES);
  };

  const blobText = (oid: string): Promise<string | null> => {
    const cached = blobs.get(oid);
    if (cached !== undefined) {
      counters.blobHits += 1;
      touch(blobs, oid, cached);
      return cached;
    }
    counters.blobLoads += 1;
    return cachePromise(
      blobs,
      oid,
      readBlobByOid({ path: vaultPath, oid }),
      MAX_BLOBS,
    );
  };

  const revision = async (
    commit: CommitOid,
    injected?: (commit: CommitOid) => Promise<TreeOid>,
  ): Promise<Revision> => {
    // Preserve the existing resolver seam: a caller-provided resolver is
    // invoked once per snapshot construction even when immutable revision
    // data is already cached. Runtime tests and alternate adapters depend on
    // this being the observable tree-resolution interface.
    if (injected !== undefined) {
      const resolvedTree = await injected(commit);
      if (!treeByCommit.has(commit)) {
        cachePromise(treeByCommit, commit, Promise.resolve(resolvedTree), MAX_REVISIONS);
      }
    }
    const cached = revisions.get(commit);
    if (cached !== undefined) {
      touch(revisions, commit, cached);
      return cached;
    }
    const loaded = buildRevision({
      vaultPath,
      commit,
      treeFor,
      manifestFor,
      blobText,
    });
    return cachePromise(revisions, commit, loaded, MAX_REVISIONS);
  };

  return Object.freeze({
    revision,
    diff: async (base: CommitOid, head: CommitOid) => {
      const [baseRevision, headRevision] = await Promise.all([
        revision(base),
        revision(head),
      ]);
      return await diffRevisions(baseRevision, headRevision);
    },
    metrics: () => Object.freeze({ ...counters }),
  });
}

async function buildRevision(opts: {
  readonly vaultPath: string;
  readonly commit: CommitOid;
  readonly treeFor: (
    commit: CommitOid,
    injected?: (commit: CommitOid) => Promise<TreeOid>,
  ) => Promise<TreeOid>;
  readonly manifestFor: (
    commit: CommitOid,
    injected?: (commit: CommitOid) => Promise<TreeOid>,
  ) => Promise<ReadonlyMap<string, ManifestEntry>>;
  readonly blobText: (oid: string) => Promise<string | null>;
}): Promise<Revision> {
  const tree = await opts.treeFor(opts.commit);
  let manifestPromise: Promise<ReadonlyMap<string, ManifestEntry>> | null = null;
  const manifest = () => {
    manifestPromise ??= opts.manifestFor(opts.commit);
    return manifestPromise;
  };
  let pathsPromise: Promise<ReadonlyArray<string>> | null = null;
  const paths = () => {
    pathsPromise ??= manifest().then((entries) =>
      Object.freeze([...entries.keys()].sort())
    );
    return pathsPromise;
  };
  let markdownPathsPromise: Promise<ReadonlyArray<string>> | null = null;
  const markdownPaths = () => {
    markdownPathsPromise ??= Promise.all([paths(), manifest()]).then(
      ([allPaths, entries]) => Object.freeze(
        allPaths.filter(
          (path) => path.endsWith(".md") && entries.get(path)?.type === "blob",
        ),
      ),
    );
    return markdownPathsPromise;
  };
  const fileInfo = new Map<string, Promise<SnapshotFileInfo | null>>();
  const snapshot: Snapshot = Object.freeze({
    commit: opts.commit,
    tree,
    readFile: async (path: string) => {
      const entry = (await manifest()).get(path);
      return entry?.type === "blob" ? opts.blobText(entry.oid) : null;
    },
    listMarkdownFiles: markdownPaths,
    getFileInfo: (path: string) => {
      const cached = fileInfo.get(path);
      if (cached !== undefined) return cached;
      const loaded = fileInfoAtCommit({
        path: opts.vaultPath,
        commit: opts.commit,
        filepath: path,
      }).then((info) => info === null
        ? null
        : Object.freeze({
            lastChangedCommit: commitOid(info.lastChangedCommit),
            lastChangedAt: info.lastChangedAt,
            lastHumanChangedAt: info.lastHumanChangedAt,
          }));
      fileInfo.set(path, loaded);
      return loaded;
    },
  });
  const internal = Object.freeze({
    commit: opts.commit,
    tree,
    paths,
    snapshot,
    __manifest: manifest,
  });
  return internal;
}

async function loadManifest(
  vaultPath: string,
  tree: TreeOid,
): Promise<ReadonlyMap<string, ManifestEntry>> {
  const out = new Map<string, ManifestEntry>();
  await walkTree(vaultPath, tree, "", out);
  return out;
}

async function walkTree(
  vaultPath: string,
  oid: string,
  prefix: string,
  out: Map<string, ManifestEntry>,
): Promise<void> {
  const result = await readTree({ path: vaultPath, oid });
  for (const entry of result.tree) {
    const path = prefix === "" ? entry.path : posix.join(prefix, entry.path);
    if (entry.type === "tree") {
      await walkTree(vaultPath, entry.oid, path, out);
    } else {
      out.set(path, Object.freeze({ oid: entry.oid, type: entry.type }));
    }
  }
}

async function diffRevisions(
  base: Revision,
  head: Revision,
): Promise<CompileRangeResult> {
  const [baseFiles, headFiles] = await Promise.all([
    revisionEntries(base),
    revisionEntries(head),
  ]);
  const addedPaths: string[] = [];
  const modifiedPaths: string[] = [];
  const deletedPaths: string[] = [];
  for (const [path, headOid] of headFiles) {
    const baseOid = baseFiles.get(path);
    if (baseOid === undefined) addedPaths.push(path);
    else if (baseOid !== headOid) modifiedPaths.push(path);
  }
  for (const path of baseFiles.keys()) {
    if (!headFiles.has(path)) deletedPaths.push(path);
  }
  addedPaths.sort();
  modifiedPaths.sort();
  deletedPaths.sort();
  const signals: SignalEvent[] = [];
  appendSignals(signals, "file.created", addedPaths, true);
  appendSignals(signals, "file.modified", modifiedPaths, true);
  appendSignals(signals, "file.deleted", deletedPaths, false);
  return Object.freeze({
    changedPaths: Object.freeze([...addedPaths, ...modifiedPaths, ...deletedPaths]),
    addedPaths: Object.freeze(addedPaths),
    modifiedPaths: Object.freeze(modifiedPaths),
    deletedPaths: Object.freeze(deletedPaths),
    signals: Object.freeze(signals),
  });
}

async function revisionEntries(
  revision: Revision,
): Promise<ReadonlyMap<string, string>> {
  const hidden = revision as Revision & {
    readonly __manifest?: () => Promise<ReadonlyMap<string, ManifestEntry>>;
  };
  if (hidden.__manifest === undefined) {
    throw new Error("revision source invariant: revision manifest missing");
  }
  return new Map(
    [...(await hidden.__manifest())].map(([path, entry]) => [path, entry.oid]),
  );
}

function appendSignals(
  out: SignalEvent[],
  signal: Signal,
  paths: ReadonlyArray<string>,
  markdownOverlay: boolean,
): void {
  for (const path of paths) {
    out.push(Object.freeze({ signal, path }));
    if (markdownOverlay && path.endsWith(".md")) {
      out.push(Object.freeze({ signal: "document.changed", path }));
    }
  }
}

function cachePromise<K, V>(
  cache: Map<K, Promise<V>>,
  key: K,
  promise: Promise<V>,
  max: number,
): Promise<V> {
  setBounded(cache, key, promise, max);
  void promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key);
  });
  return promise;
}

function setBounded<K, V>(cache: Map<K, V>, key: K, value: V, max: number): void {
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next().value as K | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function touch<K, V>(cache: Map<K, V>, key: K, value: V): void {
  cache.delete(key);
  cache.set(key, value);
}
