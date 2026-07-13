import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeterministicTar,
  assertSourceSnapshot,
  HOME_ARTIFACT_SCHEMA,
  normalizeArtifactModes,
  PINNED_AGE_ARCHIVE_SHA256,
  PINNED_AGE_ARCHIVE_URL,
  PINNED_AGE_BINARY_SHA256,
  PINNED_AGE_KEYGEN_BINARY_SHA256,
  PINNED_AGE_LICENSE_SHA256,
  PINNED_AGE_VERSION,
  PINNED_BUN_VERSION,
  verifyHomeArtifact,
  writeArtifactMetadata,
} from "../../scripts/home-artifact";
import {
  parseHomeArtifactManifest,
  verifyHomeArtifact as shippedVerifyHomeArtifact,
} from "../../src/product-host/home-artifact";

describe("Dome Home artifact", () => {
  test("the builder exports the exact shipped verifier", () => {
    expect(verifyHomeArtifact).toBe(shippedVerifyHomeArtifact);
  });

  test("writes an honest versioned manifest and sorted checksums", async () => {
    const root = await fixture();
    try {
      const manifest = await writeArtifactMetadata(root, "9.8.7");
      expect(manifest.schema).toBe(HOME_ARTIFACT_SCHEMA);
      expect(manifest.product.version).toBe("9.8.7");
      expect(manifest.runtime.version).toBe(PINNED_BUN_VERSION);
      expect(manifest.tools).toEqual([
        {
          name: "age",
          version: PINNED_AGE_VERSION,
          path: "runtime/age",
          sourceUrl: PINNED_AGE_ARCHIVE_URL,
          archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
          sha256: "unavailable",
          licensePath: "licenses/age-LICENSE",
          licenseSha256: "unavailable",
        },
        {
          name: "age-keygen",
          version: PINNED_AGE_VERSION,
          path: "runtime/age-keygen",
          sourceUrl: PINNED_AGE_ARCHIVE_URL,
          archiveSha256: PINNED_AGE_ARCHIVE_SHA256,
          sha256: "unavailable",
          licensePath: "licenses/age-LICENSE",
          licenseSha256: "unavailable",
        },
      ]);
      expect(manifest.distribution).toEqual({
        signed: false,
        notarized: false,
        upgradeSupported: false,
      });
      expect(manifest.writerBarrier).toEqual({ protocol: 1 });
      expect(manifest.entries.filter((entry) => entry.type === "file").map((entry) => entry.path)).toEqual([
        "app/pwa/dist/index.html",
        "bin/dome",
      ]);

      const checksums = (await readFile(join(root, "checksums.sha256"), "utf8"))
        .trim().split("\n");
      expect(checksums).toHaveLength(3);
      expect(checksums.map((line) => line.slice(66))).toEqual([
        "app/pwa/dist/index.html",
        "bin/dome",
        "manifest.json",
      ]);
      expect(checksums.every((line) => /^[a-f0-9]{64}  \S+$/.test(line))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("emits byte-identical tar streams independent of mtimes", async () => {
    const root = await fixture();
    try {
      await writeArtifactMetadata(root, "1.0.0");
      const first = await createDeterministicTar(root);
      await Bun.sleep(5);
      await writeFile(join(root, "app", "pwa", "dist", "index.html"), "<main>Dome</main>\n");
      const second = await createDeterministicTar(root);
      expect(digest(second)).toBe(digest(first));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects payload corruption after metadata is written", async () => {
    const root = await verifiableFixture();
    try {
      await writeFile(join(root, "app", "pwa", "dist", "index.html"), "corrupted\n");
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact checksum mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unknown manifest fields before trusting payload paths", async () => {
    const root = await verifiableFixture();
    try {
      const path = join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      manifest["futureSelector"] = "ambient-current-symlink";
      await writeFile(path, `${JSON.stringify(manifest)}\n`);
      expect(verifyHomeArtifact(root)).rejects.toThrow("unknown or missing fields");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("general manifest verification accepts legacy v1 without an upgrade protocol", async () => {
    const root = await verifiableFixture();
    try {
      const path = join(root, "manifest.json");
      const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      delete manifest["writerBarrier"];
      expect(parseHomeArtifactManifest(manifest).writerBarrier).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects escaping and broken symlinks", async () => {
    const root = await verifiableFixture();
    try {
      const link = join(root, "app", "escape");
      await symlink(tmpdir(), link);
      await writeArtifactMetadata(root, "1.0.0");
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact symlink escapes its root");
      await rm(link, { force: true });
      await symlink("missing-target", link);
      await writeArtifactMetadata(root, "1.0.0");
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact contains broken symlink");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects retargeted or added symlinks and added directories", async () => {
    const root = await verifiableFixture();
    try {
      const link = join(root, "app", "pwa-link");
      await symlink("pwa", link);
      await writeArtifactMetadata(root, "1.0.0");
      await rm(link, { force: true });
      await symlink("pwa/dist", link);
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact symlink target mismatch");

      await rm(link, { force: true });
      await writeArtifactMetadata(root, "1.0.0");
      await symlink("pwa", link);
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact entry path/type set differs");
      await rm(link, { force: true });
      await mkdir(join(root, "app", "unexpected"));
      expect(verifyHomeArtifact(root)).rejects.toThrow("artifact entry path/type set differs");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("source snapshot rejects worktree mutation and HEAD movement", async () => {
    const repo = await mkdtemp(join(tmpdir(), "dome-home-source-test-"));
    try {
      await git(repo, "init", "-q");
      await git(repo, "config", "user.name", "Artifact Test");
      await git(repo, "config", "user.email", "artifact@localhost");
      await writeFile(join(repo, "tracked.txt"), "one\n");
      await git(repo, "add", ".");
      await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "one");
      const head = (await git(repo, "rev-parse", "HEAD")).trim();
      await assertSourceSnapshot(repo, head);
      await writeFile(join(repo, "tracked.txt"), "dirty\n");
      expect(assertSourceSnapshot(repo, head)).rejects.toThrow("source worktree changed");
      await git(repo, "checkout", "--", "tracked.txt");
      await writeFile(join(repo, "tracked.txt"), "two\n");
      await git(repo, "add", ".");
      await git(repo, "-c", "commit.gpgsign=false", "commit", "-qm", "two");
      expect(assertSourceSnapshot(repo, head)).rejects.toThrow("source HEAD changed");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test("normalizes archive modes while preserving executable intent", async () => {
    const root = await fixture();
    try {
      const executable = join(root, "bin", "dome");
      const regular = join(root, "app", "pwa", "dist", "index.html");
      await chmod(executable, 0o777);
      await chmod(regular, 0o666);
      await normalizeArtifactModes(root);
      expect((await lstat(root)).mode & 0o777).toBe(0o755);
      expect((await lstat(join(root, "app"))).mode & 0o777).toBe(0o755);
      expect((await lstat(executable)).mode & 0o777).toBe(0o755);
      expect((await lstat(regular)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("pins the official age archive and both darwin-arm64 executables", () => {
    expect(PINNED_AGE_VERSION).toBe("1.3.1");
    expect(PINNED_AGE_ARCHIVE_URL).toBe(
      "https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-darwin-arm64.tar.gz",
    );
    expect(PINNED_AGE_ARCHIVE_SHA256).toBe(
      "01120ea2cbf0463d4c6bd767f99f3271bbed1cdc8a9aa718a76ba1fe4f01998b",
    );
    expect(PINNED_AGE_BINARY_SHA256).toBe(
      "0e3ea0b1bed2b30aa2dc46eef4e1723864d626c80f37319c20d9b73ca045f56f",
    );
    expect(PINNED_AGE_KEYGEN_BINARY_SHA256).toBe(
      "37c4b509d86f233d8dd065f5a905e11d2e1d5549d59445a9bc52da9235a622ad",
    );
    expect(PINNED_AGE_LICENSE_SHA256).toBe(
      "afbdb4e07a359499db587ae632815809b1fc1670a92d5449af112ce9a67833a2",
    );
  });

  test("inventories the bundled upstream age license in tool provenance and checksums", async () => {
    const root = await fixture();
    try {
      const license = Buffer.from("upstream age license fixture\n");
      await mkdir(join(root, "licenses"), { recursive: true });
      await writeFile(join(root, "licenses", "age-LICENSE"), license);
      const manifest = await writeArtifactMetadata(root, "1.0.0");
      const licenseSha256 = digest(license);
      expect(manifest.entries).toContainEqual(expect.objectContaining({
        type: "file",
        path: "licenses/age-LICENSE",
        sha256: licenseSha256,
      }));
      expect(manifest.tools.every((tool) =>
        tool.licensePath === "licenses/age-LICENSE" && tool.licenseSha256 === licenseSha256
      )).toBe(true);
      expect(await readFile(join(root, "checksums.sha256"), "utf8"))
        .toContain(`${licenseSha256}  licenses/age-LICENSE`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dome-home-artifact-test-"));
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(root, "app", "pwa", "dist"), { recursive: true });
  await writeFile(join(root, "bin", "dome"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(join(root, "bin", "dome"), 0o755);
  await writeFile(join(root, "app", "pwa", "dist", "index.html"), "<main>Dome</main>\n");
  return root;
}

async function verifiableFixture(): Promise<string> {
  const root = await fixture();
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "runtime", "bun"), `#!/bin/sh\necho ${PINNED_BUN_VERSION}\n`, { mode: 0o755 });
  await chmod(join(root, "runtime", "bun"), 0o755);
  await writeFile(join(root, "runtime", "age"), `#!/bin/sh\necho v${PINNED_AGE_VERSION}\n`, { mode: 0o755 });
  await writeFile(join(root, "runtime", "age-keygen"), `#!/bin/sh\necho v${PINNED_AGE_VERSION}\n`, { mode: 0o755 });
  await chmod(join(root, "runtime", "age"), 0o755);
  await chmod(join(root, "runtime", "age-keygen"), 0o755);
  await mkdir(join(root, "licenses"), { recursive: true });
  await writeFile(join(root, "licenses", "age-LICENSE"), "fixture license\n");
  await writeArtifactMetadata(root, "1.0.0");
  return root;
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr);
  return stdout;
}
