import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  collectManagedReleaseGarbage,
  type ManagedReleaseGcDeps,
} from "../../src/product-host/managed-release-gc";
import {
  HOME_INSTALLATION_SCHEMA,
  homeInstallationPaths,
  type HomeInstallationRecord,
} from "../../src/product-host/home-installation";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const UUID_1 = "11111111-1111-4111-8111-111111111111";
const UUID_2 = "22222222-2222-4222-8222-222222222222";
const VERSION = "1.0.0";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type ActiveMap = Map<string, { readonly old: string; readonly candidate: string }>;

describe("managed Home release reachability GC", () => {
  test("protects selected and both active sides across vaults without requiring a live vault", async () => {
    const f = await fixture();
    try {
      const first = await install(f, "first", A);
      await install(f, "second", B);
      for (const id of [A, B, C, D]) await release(f, id);
      await rm(first, { recursive: true });
      const result = await inspect(f, gcDeps(new Map([[first, { old: A, candidate: C }]])));
      expect(result.plan.protections.map((entry) => entry.artifactId)).toEqual([A, B, C]);
      expect(result.plan.protections.find((entry) => entry.artifactId === A)?.sources.map((source) => source.kind))
        .toEqual(["active-old", "selected"]);
      expect(result.plan.candidates.map((entry) => [entry.kind, entry.artifactId])).toEqual([["release", D]]);
    } finally { await cleanup(f); }
  });

  test("rejects lexical Home aliases before lock derivation", async () => {
    const f = await fixture();
    const alias = join(f.root, "Home-alias");
    try {
      await symlink(f.home, alias, "dir");
      await install(f, "vault", A);
      await release(f, A);
      await expect(collectManagedReleaseGarbage({ homeRoot: alias, mode: "inspect" }, gcDeps()))
        .rejects.toThrow();
    } finally { await cleanup(f); }
  });

  test("recognizes exact debris and installation temporaries but rejects near misses", async () => {
    const f = await fixture();
    try {
      const vault = await install(f, "vault", A);
      await release(f, A);
      const installation = homeInstallationPaths(vault, { applicationSupportDir: f.home }).installations;
      await writeFile(join(installation, `installation.json.tmp-123-${UUID_1}`), "incomplete", { mode: 0o600 });
      for (const name of [
        `.staging-${B}-123-${UUID_1}`,
        `.repair-staging-${B}-456-${UUID_1}`,
        `.quarantine-${B}-${UUID_1}`,
        `.gc-${B}-${UUID_1}`,
      ]) await mkdir(join(f.releases, name));
      expect((await inspect(f)).plan.candidates.map((entry) => entry.kind))
        .toEqual(["gc", "quarantine", "repair-staging", "staging"]);
      await mkdir(join(f.releases, `.staging-${B}-0-${UUID_1}`));
      await expect(inspect(f)).rejects.toThrow("unknown entry");
    } finally { await cleanup(f); }
  });

  test("fails closed on malformed selectors, unknown installation entries, and missing protected releases", async () => {
    for (const damage of ["record", "entry", "missing-release"] as const) {
      const f = await fixture();
      try {
        const vault = await install(f, "vault", A);
        await release(f, A);
        const installation = homeInstallationPaths(vault, { applicationSupportDir: f.home }).installations;
        if (damage === "record") {
          const record = JSON.parse(await readFile(join(installation, "installation.json"), "utf8"));
          record.unknown = true;
          await writeFile(join(installation, "installation.json"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
        } else if (damage === "entry") {
          await writeFile(join(installation, "unknown"), "x");
        } else {
          await rm(join(f.releases, A), { recursive: true });
        }
        await expect(inspect(f)).rejects.toThrow(
          damage === "missing-release" ? "protected managed release is missing" : "installation",
        );
      } finally { await cleanup(f); }
    }
  });

  test("binds selected version and active version plus manifest hash to verified releases", async () => {
    for (const damage of ["selected-version", "active-hash"] as const) {
      const f = await fixture();
      try {
        const vault = await install(f, "vault", A, damage === "selected-version" ? "9.0.0" : VERSION);
        await release(f, A);
        const deps = damage === "active-hash"
          ? gcDeps(new Map([[vault, { old: A, candidate: B }]]), { activeHash: D })
          : gcDeps();
        if (damage === "active-hash") await release(f, B);
        await expect(inspect(f, deps)).rejects.toThrow("differs from its manifest");
      } finally { await cleanup(f); }
    }
  });

  test("fails closed on symlinked release or installation entries and redirected active evidence", async () => {
    for (const damage of ["release", "installation", "active", "temporary"] as const) {
      const f = await fixture();
      try {
        const vault = await install(f, "vault", A);
        await release(f, A);
        let deps: ManagedReleaseGcDeps | undefined = gcDeps();
        if (damage === "release") {
          await release(f, B);
          await symlink(join(f.releases, B), join(f.releases, C), "dir");
        } else if (damage === "installation") {
          const installation = homeInstallationPaths(vault, { applicationSupportDir: f.home }).installations;
          await rename(installation, `${installation}-moved`);
          await symlink(`${installation}-moved`, installation, "dir");
        } else if (damage === "active") {
          const upgrade = join(homeInstallationPaths(vault, { applicationSupportDir: f.home }).installations, "upgrade");
          await mkdir(upgrade, { recursive: true, mode: 0o700 });
          await symlink(f.root, join(upgrade, "active"), "dir");
          deps = { ...gcDeps(), readActiveProtection: undefined };
        } else {
          const installation = homeInstallationPaths(vault, { applicationSupportDir: f.home }).installations;
          await symlink(f.root, join(installation, `installation.json.tmp-123-${UUID_1}`));
        }
        await expect(inspect(f, deps)).rejects.toThrow();
      } finally { await cleanup(f); }
    }
  });

  test("terminal history and receipts never pin a release", async () => {
    const f = await fixture();
    try {
      const vault = await install(f, "vault", A);
      await release(f, A);
      await release(f, B);
      const upgrade = join(homeInstallationPaths(vault, { applicationSupportDir: f.home }).installations, "upgrade");
      await mkdir(join(upgrade, "history", "mentions-B"), { recursive: true, mode: 0o700 });
      await mkdir(join(upgrade, "receipts"), { recursive: true, mode: 0o700 });
      const deps = { ...gcDeps(), readActiveProtection: undefined };
      expect((await inspect(f, deps)).plan.candidates.map((entry) => entry.artifactId)).toEqual([B]);
    } finally { await cleanup(f); }
  });

  test("revalidates the full store, candidate inode, and protections at the rename seam", async () => {
    for (const race of ["inode", "manifest", "selector", "unknown-entry"] as const) {
      const f = await fixture();
      try {
        const vault = await install(f, "vault", A);
        await release(f, A);
        await release(f, B);
        let raced = false;
        const deps: ManagedReleaseGcDeps = {
          ...gcDeps(),
          checkpoint: async (name, candidate) => {
            if (name !== "before-rename" || raced) return;
            raced = true;
            if (race === "inode") {
              await rename(candidate.path, join(f.root, "raced-B"));
              await mkdir(candidate.path);
            } else if (race === "manifest") {
              await writeFile(join(candidate.path, "manifest.json"), "changed\n", { mode: 0o644 });
            } else if (race === "selector") {
              await writeInstallationArtifact(f, vault, B);
            } else {
              await mkdir(join(f.releases, "unrecognized-race"));
            }
          },
        };
        await expect(collect(f, deps)).rejects.toThrow(
          race === "inode" ? "entry changed before collection"
            : race === "manifest" ? "manifest changed before collection"
            : race === "selector" ? "protections changed"
            : "unknown entry",
        );
        expect(await pathExists(join(f.releases, B))).toBeTrue();
      } finally { await cleanup(f); }
    }
  });

  test("reproves Home parent identities before destructive publication", async () => {
    const f = await fixture();
    try {
      await install(f, "vault", A);
      await release(f, A);
      await release(f, B);
      let raced = false;
      const deps: ManagedReleaseGcDeps = {
        ...gcDeps(),
        checkpoint: async (name) => {
          if (name !== "before-rename" || raced) return;
          raced = true;
          await rename(f.releases, join(f.root, "moved-releases"));
          await mkdir(f.releases);
        },
      };
      await expect(collect(f, deps)).rejects.toThrow("managed release root changed");
    } finally { await cleanup(f); }
  });

  test("publishes exclusively, syncs, reproofs, removes, syncs, and is idempotent", async () => {
    const f = await fixture();
    try {
      await install(f, "vault", A);
      await release(f, A);
      await release(f, B);
      const events: string[] = [];
      let syncs = 0;
      const deps: ManagedReleaseGcDeps = {
        ...gcDeps(),
        operationId: () => UUID_1,
        syncReleaseParent: async () => { syncs += 1; },
        checkpoint: async (name) => { events.push(name); },
      };
      const first = await collect(f, deps);
      expect(first.removed.map((entry) => entry.artifactId)).toEqual([B]);
      expect(events).toEqual(["before-rename", "renamed", "reproved", "removed"]);
      expect(syncs).toBe(2);
      expect((await collect(f, deps)).removed).toEqual([]);
      expect((await readdir(f.releases)).sort()).toEqual([A]);
    } finally { await cleanup(f); }
  });

  test("fully verifies each release payload exactly once regardless of candidate count", async () => {
    const f = await fixture();
    try {
      await install(f, "vault", A);
      for (const id of [A, B, C, D]) await release(f, id);
      const calls = new Map<string, number>();
      const deps: ManagedReleaseGcDeps = {
        ...gcDeps(),
        verifyRelease: async (root) => {
          const id = basename(root);
          calls.set(id, (calls.get(id) ?? 0) + 1);
          return evidence(id);
        },
      };
      expect((await collect(f, deps)).removed.map((entry) => entry.artifactId)).toEqual([B, C, D]);
      expect(Object.fromEntries(calls)).toEqual({ [A]: 1, [B]: 1, [C]: 1, [D]: 1 });
    } finally { await cleanup(f); }
  });

  test("an exclusive tombstone collision preserves both the source and existing target", async () => {
    const f = await fixture();
    try {
      await install(f, "vault", A);
      await release(f, A);
      await release(f, B);
      const target = join(await realpath(f.releases), `.gc-${B}-${UUID_1}`);
      const deps: ManagedReleaseGcDeps = {
        ...gcDeps(),
        operationId: () => UUID_1,
        publishGarbage: async (source, destination) => {
          expect(destination).toBe(target);
          await mkdir(target);
          await renameExclusive(source, destination);
        },
      };
      await expect(collect(f, deps)).rejects.toThrow("target exists");
      expect(await pathExists(join(f.releases, B))).toBeTrue();
      expect(await pathExists(target)).toBeTrue();
    } finally { await cleanup(f); }
  });

  test("leaves recognized tombstone crash debris for the next idempotent run", async () => {
    const f = await fixture();
    try {
      await install(f, "vault", A);
      await release(f, A);
      await release(f, B);
      let crashed = false;
      let parentDurable = false;
      await expect(collect(f, {
        ...gcDeps(),
        operationId: () => UUID_1,
        syncReleaseParent: async () => { parentDurable = true; },
        checkpoint: async (name) => {
          if (name === "renamed" && !crashed) {
            if (!parentDurable) throw new Error("rename was exposed before parent durability");
            crashed = true;
            throw new Error("simulated crash");
          }
        },
      })).rejects.toThrow("simulated crash");
      expect((await readdir(f.releases)).sort()).toEqual([`.gc-${B}-${UUID_1}`, A].sort());
      expect(await readFile(join(f.releases, `.gc-${B}-${UUID_1}`, "payload"), "utf8")).toBe(B);
      const second = await collect(f, { ...gcDeps(), operationId: () => UUID_2 });
      expect(second.removed.map((entry) => entry.kind)).toEqual(["gc"]);
      expect(await readdir(f.releases)).toEqual([A]);
    } finally { await cleanup(f); }
  });

  test("has no production caller or public SDK export at checkpoint 1", async () => {
    const sourceRoot = join(import.meta.dir, "../../src");
    const offenders: string[] = [];
    for (const path of await sourceFiles(sourceRoot)) {
      if (basename(path) === "managed-release-gc.ts") continue;
      if ((await readFile(path, "utf8")).includes("managed-release-gc")) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dome-managed-release-gc-"));
  const home = join(root, "Home");
  const releases = join(home, "releases");
  const installations = join(home, "installations");
  const vaults = join(root, "vaults");
  await Promise.all([
    mkdir(releases, { recursive: true }),
    mkdir(installations, { recursive: true }),
    mkdir(vaults, { recursive: true }),
  ]);
  return { root, home: await realpath(home), releases, installations, vaults };
}

async function install(f: Fixture, name: string, artifactId: string, version = VERSION): Promise<string> {
  const vault = join(f.vaults, name);
  await mkdir(vault);
  const paths = homeInstallationPaths(vault, { applicationSupportDir: f.home });
  await mkdir(paths.installations, { recursive: true });
  await writeInstallationArtifact(f, vault, artifactId, version);
  return vault;
}

async function writeInstallationArtifact(f: Fixture, vault: string, artifactId: string, version = VERSION): Promise<void> {
  const record: HomeInstallationRecord = {
    schema: HOME_INSTALLATION_SCHEMA,
    vault,
    artifact: { id: artifactId, version },
    environment: [],
  };
  const path = homeInstallationPaths(vault, { applicationSupportDir: f.home }).record;
  await writeFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function release(f: Fixture, artifactId: string): Promise<void> {
  const root = join(f.releases, artifactId);
  await mkdir(root);
  await writeFile(join(root, "manifest.json"), releaseManifest(artifactId), { mode: 0o644 });
  await writeFile(join(root, "payload"), artifactId);
}

function evidence(artifactId: string, manifestSha256 = manifestHash(artifactId)) {
  return Object.freeze({ artifactId, version: VERSION, manifestSha256 });
}

function releaseManifest(artifactId: string): string {
  return `${JSON.stringify({ artifact: { id: artifactId }, product: { version: VERSION } })}\n`;
}

function manifestHash(artifactId: string): string {
  return createHash("sha256").update(releaseManifest(artifactId)).digest("hex");
}

function gcDeps(
  active: ActiveMap = new Map(),
  options: { readonly activeHash?: string } = {},
): ManagedReleaseGcDeps {
  return {
    verifyRelease: async (root) => evidence(basename(root)),
    readActiveProtection: async (vault) => {
      const value = active.get(vault);
      return value === undefined ? null : Object.freeze({
        old: evidence(value.old, options.activeHash),
        candidate: evidence(value.candidate, options.activeHash),
      });
    },
    publishGarbage: renameExclusive,
  };
}

async function renameExclusive(source: string, target: string): Promise<void> {
  if (await pathExists(target)) throw new Error("test exclusive publication target exists");
  await rename(source, target);
}

async function inspect(f: Fixture, deps: ManagedReleaseGcDeps = gcDeps()) {
  return await collectManagedReleaseGarbage({ homeRoot: f.home, mode: "inspect" }, deps);
}

async function collect(f: Fixture, deps: ManagedReleaseGcDeps = gcDeps()) {
  return await collectManagedReleaseGarbage({ homeRoot: f.home, mode: "collect" }, deps);
}

async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function sourceFiles(root: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await sourceFiles(path));
    else if (entry.isFile() && path.endsWith(".ts")) paths.push(path);
  }
  return paths;
}

async function cleanup(f: Fixture): Promise<void> {
  await rm(f.root, { recursive: true, force: true });
}
