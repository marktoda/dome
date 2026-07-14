// product-host/managed-release-gc: one dormant, host-wide reachability collector.
//
// This checkpoint deliberately has no CLI or automatic caller. Its lock is the
// future global release-store rank, but existing writer paths do not
// participate yet. The collector holds no per-vault lock. Collection in
// production is forbidden until writers share the global rank in the order
// documented by the Product Host spec.

import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compareStrings } from "../core/compare";
import { publishDirectoryExclusive } from "../platform/exclusive-rename";
import { vaultServiceSlug } from "../surface/service-probe";
import { verifyHomeArtifact } from "./home-artifact";
import {
  homeInstallationPaths,
  parseHomeInstallationRecord,
  type HomeInstallationRecord,
} from "./home-installation";
import { readHomeUpgradeDispositionFromInstallation } from "./home-upgrade-transaction";
import { withManagedReleaseStoreCoordinator } from "./managed-release-store-coordinator";

const ARTIFACT_ID = /^[a-f0-9]{64}$/;
const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID = new RegExp(`^${UUID_SOURCE}$`);
const DEBRIS = new RegExp(
  `^(?:\\.staging-([a-f0-9]{64})-[1-9][0-9]*-(${UUID_SOURCE})|` +
    `\\.repair-staging-([a-f0-9]{64})-[1-9][0-9]*-(${UUID_SOURCE})|` +
    `\\.quarantine-([a-f0-9]{64})-(${UUID_SOURCE})|` +
    `\\.gc-([a-f0-9]{64})-(${UUID_SOURCE}))$`,
);
const INSTALLATION_TEMPORARY = new RegExp(`^installation\\.json\\.tmp-[1-9][0-9]*-${UUID_SOURCE}$`);
const MAX_INSTALLATIONS = 4_096;
const MAX_INSTALLATION_ENTRIES = 32;
const MAX_RELEASE_ENTRIES = 16_384;

export type ManagedReleaseProtectionKind = "selected" | "active-old" | "active-candidate";

export type ManagedReleaseProtection = Readonly<{
  artifactId: string;
  sources: ReadonlyArray<Readonly<{
    installation: string;
    kind: ManagedReleaseProtectionKind;
    version: string;
    manifestSha256: string | null;
  }>>;
}>;

export type ManagedReleaseGcCandidateKind = "release" | "staging" | "repair-staging" | "quarantine" | "gc";

export type ManagedReleaseGcCandidate = Readonly<{
  artifactId: string;
  kind: ManagedReleaseGcCandidateKind;
  name: string;
  path: string;
  identity: Readonly<{ dev: string; ino: string }>;
}>;

export type ManagedReleaseGcPlan = Readonly<{
  homeRoot: string;
  releasesRoot: string;
  protections: ReadonlyArray<ManagedReleaseProtection>;
  candidates: ReadonlyArray<ManagedReleaseGcCandidate>;
}>;

export type ManagedReleaseGcResult = Readonly<{
  mode: "inspect" | "collect";
  plan: ManagedReleaseGcPlan;
  removed: ReadonlyArray<ManagedReleaseGcCandidate>;
}>;

type VerifiedRelease = Readonly<{
  artifactId: string;
  version: string;
  manifestSha256: string;
}>;

type ActiveProtection = Readonly<{
  old: VerifiedRelease;
  candidate: VerifiedRelease;
}>;

export type ManagedReleaseGcDeps = Readonly<{
  verifyRelease?: ((root: string) => Promise<VerifiedRelease>) | undefined;
  readActiveProtection?: ((vaultIdentity: string, homeRoot: string) => Promise<ActiveProtection | null>) | undefined;
  publishGarbage?: ((source: string, target: string) => Promise<void>) | undefined;
  syncReleaseParent?: ((path: string) => Promise<void>) | undefined;
  operationId?: (() => string) | undefined;
  checkpoint?: ((name: "before-rename" | "renamed" | "reproved" | "removed", candidate: ManagedReleaseGcCandidate) => Promise<void>) | undefined;
}>;

/**
 * The only collector interface: acquire ownership, inventory all references,
 * optionally remove exactly the resulting unreachable set, and return the
 * immutable evidence. `inspect` is non-mutating; `collect` remains deliberately
 * unwired until every release publisher and selector writer shares this lock.
 */
export async function collectManagedReleaseGarbage(
  input: Readonly<{ homeRoot: string; mode: "inspect" | "collect" }>,
  deps: ManagedReleaseGcDeps = {},
): Promise<ManagedReleaseGcResult> {
  const homeRoot = await canonicalDirectHomeRoot(input.homeRoot);
  const ownership = await withManagedReleaseStoreCoordinator(homeRoot, async () => {
    const roots = await inspectRoots(homeRoot);
    const built = await buildPlan(roots, deps);
    if (input.mode === "inspect") return makeResult(input.mode, built.plan, []);
    const removed = await collectPlan(roots, built, deps);
    return makeResult(input.mode, built.plan, removed);
  }, { waitMs: 0 });
  if (ownership.kind === "busy") throw new Error("managed Home release store coordinator is busy");
  return ownership.value;
}

type RootEvidence = Readonly<{
  homeRoot: string;
  releasesRoot: string;
  installationsRoot: string;
  homeIdentity: Readonly<{ dev: string; ino: string }>;
  releasesIdentity: Readonly<{ dev: string; ino: string }>;
  installationsIdentity: Readonly<{ dev: string; ino: string }>;
}>;

type ReleaseEntryEvidence = Readonly<{
  artifactId: string;
  kind: ManagedReleaseGcCandidateKind | "verified-release";
  name: string;
  path: string;
  identity: Readonly<{ dev: string; ino: string }>;
}>;

type BuiltPlan = Readonly<{
  plan: ManagedReleaseGcPlan;
  entries: ReadonlyArray<ReleaseEntryEvidence>;
  candidateManifests: ReadonlyMap<string, string>;
}>;

async function inspectRoots(homeRoot: string): Promise<RootEvidence> {
  const releasesRoot = join(homeRoot, "releases");
  const installationsRoot = join(homeRoot, "installations");
  return Object.freeze({
    homeRoot,
    releasesRoot,
    installationsRoot,
    homeIdentity: await directDirectoryIdentity(homeRoot, "managed Home root"),
    releasesIdentity: await directDirectoryIdentity(releasesRoot, "managed release root"),
    installationsIdentity: await directDirectoryIdentity(installationsRoot, "managed installation root"),
  });
}

async function buildPlan(roots: RootEvidence, deps: ManagedReleaseGcDeps): Promise<BuiltPlan> {
  await reproveRoots(roots);
  const protections = await inventoryProtections(roots, deps);
  const protectedById = new Map(protections.map((entry) => [entry.artifactId, entry]));
  const releases = new Set<string>();
  const candidates: ManagedReleaseGcCandidate[] = [];
  const candidateManifests = new Map<string, string>();
  const entries = await inventoryReleaseEntries(roots);
  for (const entry of entries) {
    if (entry.kind === "verified-release") {
      const verified = await verifyRelease(entry.path, deps);
      if (verified.artifactId !== entry.name) {
        throw new Error(`managed release identity differs from its directory: ${entry.name}`);
      }
      assertArtifactId(verified.artifactId, "verified artifact id");
      assertVersion(verified.version, "verified artifact version");
      assertSha(verified.manifestSha256, "verified manifest hash");
      const protection = protectedById.get(entry.name);
      if (protection === undefined) {
        candidates.push(candidate(entry.name, entry.path, entry.name, "release", entry.identity));
        candidateManifests.set(entry.name, verified.manifestSha256);
      }
      else assertProtectionMatchesRelease(protection, verified);
      releases.add(entry.name);
      continue;
    }
    candidates.push(candidate(entry.artifactId, entry.path, entry.name, entry.kind, entry.identity));
  }
  for (const protection of protections) {
    if (!releases.has(protection.artifactId)) {
      throw new Error(`protected managed release is missing: ${protection.artifactId}`);
    }
  }
  candidates.sort((left, right) => compareStrings(left.name, right.name));
  await reproveRoots(roots);
  return Object.freeze({
    plan: Object.freeze({
      homeRoot: roots.homeRoot,
      releasesRoot: roots.releasesRoot,
      protections,
      candidates: Object.freeze(candidates),
    }),
    entries,
    candidateManifests,
  });
}

async function inventoryReleaseEntries(roots: RootEvidence): Promise<ReadonlyArray<ReleaseEntryEvidence>> {
  await reproveRoots(roots);
  const entries: ReleaseEntryEvidence[] = [];
  for (const name of await boundedNames(roots.releasesRoot, MAX_RELEASE_ENTRIES, "managed releases")) {
    const path = join(roots.releasesRoot, name);
    const identity = await directDirectoryIdentity(path, "managed release entry");
    if (ARTIFACT_ID.test(name)) {
      entries.push(Object.freeze({ artifactId: name, kind: "verified-release", name, path, identity }));
      continue;
    }
    const debris = parseDebris(name);
    if (debris === null) throw new Error(`managed release store has an unknown entry: ${name}`);
    entries.push(Object.freeze({ artifactId: debris.artifactId, kind: debris.kind, name, path, identity }));
  }
  await reproveRoots(roots);
  return Object.freeze(entries);
}

async function inventoryProtections(
  roots: RootEvidence,
  deps: ManagedReleaseGcDeps,
): Promise<ReadonlyArray<ManagedReleaseProtection>> {
  await reproveRoots(roots);
  const sources = new Map<string, Array<ManagedReleaseProtection["sources"][number]>>();
  for (const installation of await boundedNames(roots.installationsRoot, MAX_INSTALLATIONS, "managed installations")) {
    const installationRoot = join(roots.installationsRoot, installation);
    await directDirectoryIdentity(installationRoot, "managed installation");
    const names = await boundedNames(installationRoot, MAX_INSTALLATION_ENTRIES, "managed installation");
    if (!names.includes("installation.json") || names.some((name) =>
      name !== "installation.json" && name !== "upgrade" && !INSTALLATION_TEMPORARY.test(name))) {
      throw new Error(`managed installation has unknown or missing entries: ${installation}`);
    }
    if (names.includes("upgrade")) {
      await directDirectoryIdentity(join(installationRoot, "upgrade"), "managed upgrade root");
    }
    for (const name of names.filter((candidate) => INSTALLATION_TEMPORARY.test(candidate))) {
      await assertPrivateTemporary(join(installationRoot, name));
    }
    const record = await readInstallationRecord(join(installationRoot, "installation.json"));
    if (vaultServiceSlug(record.vault) !== installation ||
      homeInstallationPaths(record.vault, { applicationSupportDir: roots.homeRoot }).installations !== installationRoot) {
      throw new Error(`managed installation identity does not match its directory: ${installation}`);
    }
    addProtection(sources, record.artifact.id, {
      installation, kind: "selected", version: record.artifact.version, manifestSha256: null,
    });
    const active = await readActiveProtection(record.vault, roots.homeRoot, deps);
    if (active !== null) {
      if (active.old.artifactId === active.candidate.artifactId) {
        throw new Error("active managed release protection is not a distinct upgrade pair");
      }
      addActiveProtection(sources, active.old, installation, "active-old");
      addActiveProtection(sources, active.candidate, installation, "active-candidate");
    }
  }
  await reproveRoots(roots);
  return Object.freeze([...sources]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([artifactId, values]) => Object.freeze({
      artifactId,
      sources: Object.freeze([...values].sort((left, right) =>
        compareStrings(`${left.installation}\0${left.kind}`, `${right.installation}\0${right.kind}`))),
    })));
}

async function collectPlan(
  roots: RootEvidence,
  built: BuiltPlan,
  deps: ManagedReleaseGcDeps,
): Promise<ReadonlyArray<ManagedReleaseGcCandidate>> {
  const removed: ManagedReleaseGcCandidate[] = [];
  const expectedEntries = new Map(built.entries.map((entry) => [entry.name, entry.identity]));
  for (const entry of built.plan.candidates) {
    await assertCheapState(
      entry, built.plan.protections, expectedEntries, built.candidateManifests.get(entry.name), roots, deps,
    );
    await deps.checkpoint?.("before-rename", entry);
    const beforeRename = await assertCheapState(
      entry, built.plan.protections, expectedEntries, built.candidateManifests.get(entry.name), roots, deps,
    );
    if (beforeRename.dev !== roots.releasesIdentity.dev) {
      throw new Error(`managed release GC candidate is on another device: ${entry.name}`);
    }
    const operationId = (deps.operationId ?? randomUUID)();
    if (!UUID.test(operationId)) throw new Error("managed release GC operation id is invalid");
    const garbage = join(roots.releasesRoot, `.gc-${entry.artifactId}-${operationId}`);
    const publish = deps.publishGarbage ?? (async (source: string, target: string) => {
      await publishDirectoryExclusive({ source, target });
    });
    await publish(entry.path, garbage);
    await (deps.syncReleaseParent ?? syncDirectory)(roots.releasesRoot);
    await deps.checkpoint?.("renamed", entry);
    await assertAbsent(entry.path, "managed release GC source");
    const renamed = await directDirectoryIdentity(garbage, "managed release GC tombstone");
    assertIdentity(entry, renamed, "changed across rename");
    await deps.checkpoint?.("reproved", entry);
    await rm(garbage, { recursive: true, force: false });
    await (deps.syncReleaseParent ?? syncDirectory)(roots.releasesRoot);
    await deps.checkpoint?.("removed", entry);
    removed.push(entry);
    expectedEntries.delete(entry.name);
  }
  return Object.freeze(removed);
}

async function assertCheapState(
  expectedCandidate: ManagedReleaseGcCandidate,
  expectedProtections: ReadonlyArray<ManagedReleaseProtection>,
  expectedEntries: ReadonlyMap<string, Readonly<{ dev: string; ino: string }>>,
  expectedManifestSha256: string | undefined,
  roots: RootEvidence,
  deps: ManagedReleaseGcDeps,
): Promise<Readonly<{ dev: string; ino: string }>> {
  await reproveRoots(roots);
  const protections = await inventoryProtections(roots, deps);
  if (JSON.stringify(protections) !== JSON.stringify(expectedProtections)) {
    throw new Error("managed release protections changed before collection");
  }
  const entries = await inventoryReleaseEntries(roots);
  if (entries.length !== expectedEntries.size) throw new Error("managed release store names changed before collection");
  for (const entry of entries) {
    const expected = expectedEntries.get(entry.name);
    if (expected === undefined) throw new Error("managed release store names changed before collection");
    if (entry.identity.dev !== expected.dev || entry.identity.ino !== expected.ino) {
      throw new Error(`managed release store entry changed before collection: ${entry.name}`);
    }
  }
  const candidate = entries.find((entry) => entry.name === expectedCandidate.name);
  if (candidate === undefined) {
    throw new Error(`managed release GC candidate is no longer unreachable: ${expectedCandidate.name}`);
  }
  assertIdentity(expectedCandidate, candidate.identity, "changed before rename");
  if (expectedManifestSha256 !== undefined) {
    const manifest = await readStableBoundedFile(
      join(candidate.path, "manifest.json"), 16 * 1024 * 1024, "managed release candidate manifest", null,
    );
    if (sha256(manifest) !== expectedManifestSha256) {
      throw new Error(`managed release candidate manifest changed before collection: ${candidate.name}`);
    }
  }
  return candidate.identity;
}

async function readActiveProtection(
  vaultIdentity: string,
  homeRoot: string,
  deps: ManagedReleaseGcDeps,
): Promise<ActiveProtection | null> {
  if (deps.readActiveProtection !== undefined) return await deps.readActiveProtection(vaultIdentity, homeRoot);
  const active = await readHomeUpgradeDispositionFromInstallation(vaultIdentity, { applicationSupportDir: homeRoot });
  return active === null ? null : Object.freeze({
    old: Object.freeze({
      artifactId: active.old.artifactId,
      version: active.old.version,
      manifestSha256: active.old.manifestSha256,
    }),
    candidate: Object.freeze({
      artifactId: active.candidate.artifactId,
      version: active.candidate.version,
      manifestSha256: active.candidate.manifestSha256,
    }),
  });
}

async function verifyRelease(root: string, deps: ManagedReleaseGcDeps): Promise<VerifiedRelease> {
  if (deps.verifyRelease !== undefined) return await deps.verifyRelease(root);
  const manifestPath = join(root, "manifest.json");
  const before = sha256(await readFile(manifestPath));
  const manifest = await verifyHomeArtifact(root);
  const after = sha256(await readFile(manifestPath));
  if (before !== after) throw new Error("managed release manifest changed during verification");
  return Object.freeze({
    artifactId: manifest.artifact.id,
    version: manifest.product.version,
    manifestSha256: after,
  });
}

async function readInstallationRecord(path: string): Promise<HomeInstallationRecord> {
  const bytes = await readStableBoundedFile(path, 1024 * 1024, "managed installation record", 0o600);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("managed installation record is invalid JSON"); }
  const vault = value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)["vault"]
    : null;
  if (typeof vault !== "string" || vault !== resolve(vault)) {
    throw new Error("managed installation record vault is not absolute and normalized");
  }
  return parseHomeInstallationRecord(value, vault);
}

async function readStableBoundedFile(
  path: string,
  maximum: number,
  label: string,
  requiredMode: number | null,
): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n ||
      (requiredMode !== null && (before.mode & 0o777n) !== BigInt(requiredMode)) ||
      before.size === 0n || before.size > BigInt(maximum)) {
      throw new Error(`${label} is not a bounded private direct file`);
    }
    const bytes = await readFile(handle);
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new Error(`${label} changed while read`);
    const pathInfo = await lstat(path, { bigint: true });
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.dev !== after.dev || pathInfo.ino !== after.ino) {
      throw new Error(`${label} path changed while read`);
    }
    return bytes;
  } finally { await handle.close(); }
}

async function assertPrivateTemporary(path: string): Promise<void> {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n) {
    throw new Error("managed installation temporary is not a private direct file");
  }
}

async function canonicalDirectHomeRoot(path: string): Promise<string> {
  const normalized = resolve(path);
  if (path !== normalized) throw new Error("managed Home root must be absolute and normalized");
  await directDirectoryIdentity(normalized, "managed Home root");
  return normalized;
}

async function directDirectoryIdentity(path: string, label: string): Promise<{ readonly dev: string; readonly ino: string }> {
  const normalized = resolve(path);
  const handle = await open(normalized, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    const pathInfo = await lstat(normalized, { bigint: true });
    if (!before.isDirectory() || !pathInfo.isDirectory() || pathInfo.isSymbolicLink() ||
      before.dev !== pathInfo.dev || before.ino !== pathInfo.ino || await realpath(normalized) !== normalized) {
      throw new Error(`${label} is not a stable direct directory`);
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode) {
      throw new Error(`${label} changed during inspection`);
    }
    return Object.freeze({ dev: after.dev.toString(), ino: after.ino.toString() });
  } finally { await handle.close(); }
}

async function reproveRoots(roots: RootEvidence): Promise<void> {
  assertRootIdentity("managed Home root", roots.homeIdentity, await directDirectoryIdentity(roots.homeRoot, "managed Home root"));
  assertRootIdentity("managed release root", roots.releasesIdentity, await directDirectoryIdentity(roots.releasesRoot, "managed release root"));
  assertRootIdentity("managed installation root", roots.installationsIdentity, await directDirectoryIdentity(roots.installationsRoot, "managed installation root"));
}

function assertRootIdentity(label: string, expected: { dev: string; ino: string }, actual: { dev: string; ino: string }): void {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) throw new Error(`${label} changed during collection`);
}

async function boundedNames(path: string, maximum: number, label: string): Promise<ReadonlyArray<string>> {
  const names = await readdir(path);
  if (names.length > maximum) throw new Error(`${label} exceed the inventory budget`);
  return names.sort(compareStrings);
}

function candidate(
  artifactId: string,
  path: string,
  name: string,
  kind: ManagedReleaseGcCandidateKind,
  identity: { readonly dev: string; readonly ino: string },
): ManagedReleaseGcCandidate {
  return Object.freeze({ artifactId, kind, name, path, identity });
}

function parseDebris(name: string): { readonly artifactId: string; readonly kind: ManagedReleaseGcCandidateKind } | null {
  const matched = DEBRIS.exec(name);
  if (matched === null) return null;
  const artifactId = matched[1] ?? matched[3] ?? matched[5] ?? matched[7];
  const kind = matched[1] !== undefined ? "staging"
    : matched[3] !== undefined ? "repair-staging"
    : matched[5] !== undefined ? "quarantine"
    : "gc";
  return artifactId === undefined ? null : Object.freeze({ artifactId, kind });
}

function addActiveProtection(
  protections: Map<string, Array<ManagedReleaseProtection["sources"][number]>>,
  artifact: VerifiedRelease,
  installation: string,
  kind: "active-old" | "active-candidate",
): void {
  assertSha(artifact.manifestSha256, `${kind} manifest hash`);
  addProtection(protections, artifact.artifactId, {
    installation, kind, version: artifact.version, manifestSha256: artifact.manifestSha256,
  });
}

function addProtection(
  protections: Map<string, Array<ManagedReleaseProtection["sources"][number]>>,
  artifactId: string,
  source: ManagedReleaseProtection["sources"][number],
): void {
  assertArtifactId(artifactId, `${source.kind} artifact id`);
  assertVersion(source.version, `${source.kind} artifact version`);
  const values = protections.get(artifactId) ?? [];
  values.push(Object.freeze({ ...source }));
  protections.set(artifactId, values);
}

function assertProtectionMatchesRelease(protection: ManagedReleaseProtection, release: VerifiedRelease): void {
  for (const source of protection.sources) {
    if (source.version !== release.version ||
      (source.manifestSha256 !== null && source.manifestSha256 !== release.manifestSha256)) {
      throw new Error(`protected managed release evidence differs from its manifest: ${release.artifactId}`);
    }
  }
}

function assertArtifactId(value: string, label: string): void {
  if (!ARTIFACT_ID.test(value)) throw new Error(`${label} is invalid`);
}

function assertVersion(value: string, label: string): void {
  if (value.length === 0 || value.length > 1024) throw new Error(`${label} is invalid`);
}

function assertSha(value: string, label: string): void {
  if (!ARTIFACT_ID.test(value)) throw new Error(`${label} is invalid`);
}

function assertIdentity(
  candidate: ManagedReleaseGcCandidate,
  actual: { readonly dev: string; readonly ino: string },
  suffix: string,
): void {
  if (candidate.identity.dev !== actual.dev || candidate.identity.ino !== actual.ino) {
    throw new Error(`managed release GC candidate ${suffix}: ${candidate.name}`);
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs;
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try { await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} remains present after exclusive publication`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeResult(
  mode: "inspect" | "collect",
  plan: ManagedReleaseGcPlan,
  removed: ReadonlyArray<ManagedReleaseGcCandidate>,
): ManagedReleaseGcResult {
  return Object.freeze({ mode, plan, removed: Object.freeze([...removed]) });
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
