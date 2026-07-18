import { isAbsolute } from "node:path";

export const PRODUCT_PACKAGE_SCHEMA = "dome.product-package/v1" as const;
export const PRODUCT_PACKAGE_NAME = "@marktoda/dome" as const;
export const PRODUCT_PACKAGE_VERSION = "0.4.0" as const;
export const PRODUCT_PACKAGE_SOURCE_PATHS = Object.freeze([
  "src/",
  "contracts/agent-stream.ts",
  "contracts/capture.ts",
  "contracts/product-readiness.ts",
  "contracts/source-document.ts",
  "contracts/task-backlog.ts",
  "contracts/task-backlog-review.ts",
  "assets/extensions/",
  "assets/model-providers/",
  "assets/source-handlers/",
  "bin/dome",
  "LICENSE",
  "README.md",
  "package.json",
]);

export const PRODUCT_PACKAGE_CAPS = Object.freeze({
  sourceEntries: 600,
  sourceFileBytes: 4 * 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
  pwaEntries: 256,
  pwaBytes: 16 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024,
  packedEntries: 900,
  packedBytes: 64 * 1024 * 1024,
  unpackedBytes: 72 * 1024 * 1024,
});

export type ProductPackageFile = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  mode: "0644" | "0755";
}>;

export type ProductPackageManifest = Readonly<{
  schema: typeof PRODUCT_PACKAGE_SCHEMA;
  package: Readonly<{
    name: typeof PRODUCT_PACKAGE_NAME;
    version: typeof PRODUCT_PACKAGE_VERSION;
    sourceCommit: string;
  }>;
  platform: Readonly<{ os: "darwin"; arch: "arm64" }>;
  home: Readonly<{
    path: string;
    bytes: number;
    sha256: string;
    root: string;
    manifestSha256: string;
    artifactId: string;
    productVersion: typeof PRODUCT_PACKAGE_VERSION;
    buildCommit: string;
  }>;
  pwa: Readonly<{
    root: "product/pwa";
    entries: ReadonlyArray<ProductPackageFile>;
  }>;
  /** Every packed file except product/manifest.json itself. */
  files: ReadonlyArray<ProductPackageFile>;
}>;

export function validateProductPackageManifest(value: unknown): ProductPackageManifest {
  if (!isRecord(value) || value["schema"] !== PRODUCT_PACKAGE_SCHEMA) {
    throw new Error("product package manifest schema is invalid");
  }
  exactKeys(value, ["schema", "package", "platform", "home", "pwa", "files"], "product package manifest");
  const packageIdentity = exactRecord(value["package"], ["name", "version", "sourceCommit"], "product package identity");
  const platform = exactRecord(value["platform"], ["os", "arch"], "product package platform");
  const home = exactRecord(value["home"], [
    "path", "bytes", "sha256", "root", "manifestSha256", "artifactId", "productVersion", "buildCommit",
  ], "product Home identity");
  const pwa = exactRecord(value["pwa"], ["root", "entries"], "product PWA identity");
  const manifest = value as ProductPackageManifest;
  if (packageIdentity["name"] !== PRODUCT_PACKAGE_NAME || packageIdentity["version"] !== PRODUCT_PACKAGE_VERSION ||
    typeof packageIdentity["sourceCommit"] !== "string" || !/^[0-9a-f]{40}$/.test(packageIdentity["sourceCommit"]) ||
    platform["os"] !== "darwin" || platform["arch"] !== "arm64" ||
    home["productVersion"] !== PRODUCT_PACKAGE_VERSION || home["buildCommit"] !== packageIdentity["sourceCommit"]) {
    throw new Error("product package identity is invalid");
  }
  if (typeof home["path"] !== "string" || !Number.isSafeInteger(home["bytes"]) || (home["bytes"] as number) < 1 ||
    typeof home["sha256"] !== "string" || typeof home["root"] !== "string" ||
    typeof home["manifestSha256"] !== "string" || typeof home["artifactId"] !== "string" ||
    typeof home["buildCommit"] !== "string") {
    throw new Error("product Home identity is invalid");
  }
  if (!Array.isArray(manifest.files) || !Array.isArray(pwa["entries"]) || pwa["root"] !== "product/pwa") {
    throw new Error("product package inventories are invalid");
  }
  validateClosedFiles(manifest.files, "product package");
  validateClosedFiles(manifest.pwa.entries, "product PWA");
  if (manifest.files.length > PRODUCT_PACKAGE_CAPS.packedEntries - 1 ||
    sumBytes(manifest.files) > PRODUCT_PACKAGE_CAPS.unpackedBytes) {
    throw new Error("product package inventory exceeds its entry or byte budget");
  }
  if (manifest.files.some((entry) => entry.path === "product/manifest.json")) {
    throw new Error("product package inventory must exclude its manifest");
  }
  const pwaFromFiles = manifest.files.filter((entry) => entry.path.startsWith("product/pwa/"));
  if (JSON.stringify(pwaFromFiles) !== JSON.stringify(manifest.pwa.entries) ||
    manifest.pwa.entries.length > PRODUCT_PACKAGE_CAPS.pwaEntries ||
    sumBytes(manifest.pwa.entries) > PRODUCT_PACKAGE_CAPS.pwaBytes ||
    !manifest.pwa.entries.some((entry) => entry.path === "product/pwa/index.html")) {
    throw new Error("product PWA inventory differs from the package inventory or exceeds its budget");
  }
  if (manifest.pwa.entries.some((entry) => entry.mode !== "0644")) {
    throw new Error("product PWA inventory contains a non-normalized mode");
  }
  const homeFile = manifest.files.find((entry) => entry.path === manifest.home.path);
  const homeFiles = manifest.files.filter((entry) => entry.path.startsWith("product/home/"));
  if (homeFiles.length !== 1 || homeFile === undefined || homeFile.bytes !== manifest.home.bytes ||
    homeFile.bytes > PRODUCT_PACKAGE_CAPS.packedBytes ||
    homeFile.sha256 !== manifest.home.sha256 || homeFile.mode !== "0644" ||
    !/^product\/home\/dome-home-0\.4\.0-darwin-arm64\.tar\.gz$/.test(manifest.home.path) ||
    manifest.home.root !== "dome-home-0.4.0-darwin-arm64" ||
    !/^[0-9a-f]{64}$/.test(manifest.home.sha256) || !/^[0-9a-f]{64}$/.test(manifest.home.manifestSha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.home.artifactId)) {
    throw new Error("product Home identity differs from the package inventory");
  }
  const sourceFiles = manifest.files.filter((entry) => !entry.path.startsWith("product/"));
  if (sourceFiles.length > PRODUCT_PACKAGE_CAPS.sourceEntries || sumBytes(sourceFiles) > PRODUCT_PACKAGE_CAPS.sourceBytes ||
    sourceFiles.some((entry) => entry.bytes > PRODUCT_PACKAGE_CAPS.sourceFileBytes || !isProductPackageSourcePath(entry.path))) {
    throw new Error("product package source inventory exceeds its allowlist or budget");
  }
  for (const required of ["package.json", "LICENSE", "README.md", "bin/dome", "src/index.ts"] as const) {
    if (!sourceFiles.some((entry) => entry.path === required)) {
      throw new Error(`product package source inventory is missing ${required}`);
    }
  }
  if (sourceFiles.find((entry) => entry.path === "bin/dome")?.mode !== "0755") {
    throw new Error("product package bin/dome is not executable");
  }
  if (manifest.files.some((entry) => entry.path.startsWith("product/") &&
    !entry.path.startsWith("product/pwa/") && entry.path !== manifest.home.path)) {
    throw new Error("product package contains an unexpected generated product path");
  }
  return manifest;
}

export function isProductPackageSourcePath(path: string): boolean {
  return PRODUCT_PACKAGE_SOURCE_PATHS.some((allowed) => allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed);
}

export function assertProductPackageSafePath(path: string): void {
  if (!isSafeRelativePath(path)) throw new Error(`product package contains an unsafe path: ${path}`);
  if (/(^|\/)(?:\.env(?:\.|$)|id_rsa$|id_ed25519$|secrets?\/)|\.(?:pem|p12|key)$/i.test(path) ||
    /^(?:docs|tests|scripts|pwa|node_modules)(\/|$)/i.test(path) ||
    /(^|\/)(?:\.codex|worktrees)(\/|$)/i.test(path)) {
    throw new Error(`product package contains development or secret path: ${path}`);
  }
}

function validateClosedFiles(files: ReadonlyArray<ProductPackageFile>, label: string): void {
  const paths = files.map((entry) => entry.path);
  if (paths.length === 0 || JSON.stringify(paths) !== JSON.stringify([...paths].sort()) || new Set(paths).size !== paths.length) {
    throw new Error(`${label} paths are empty, duplicate, or unsorted`);
  }
  for (const entry of files) {
    if (!isRecord(entry)) throw new Error(`${label} contains a non-object file row`);
    exactKeys(entry, ["path", "bytes", "sha256", "mode"], `${label} file row`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      (entry.mode !== "0644" && entry.mode !== "0755")) {
      throw new Error(`${label} contains invalid file evidence: ${entry.path}`);
    }
    assertProductPackageSafePath(entry.path);
  }
}

function sumBytes(files: ReadonlyArray<ProductPackageFile>): number {
  return files.reduce((sum, entry) => sum + entry.bytes, 0);
}

function isSafeRelativePath(path: string): boolean {
  return path !== "" && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function exactRecord(value: unknown, keys: ReadonlyArray<string>, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`);
  exactKeys(value, keys, label);
  return value;
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: ReadonlyArray<string>, label: string): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
