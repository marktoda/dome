import { createHash } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";

import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const GENERATION_MARKER = '<meta name="dome-rehearsal-generation" content="synthetic-predecessor">';
const CAPTURE_TEXT = "Dome PWA waiting-worker local survival canary";
const WAIT_MS = 15_000;
const PHASE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const HANDLE_CLOSE_TIMEOUT_MS = 5_000;
const MAX_STATIC_FILES = 256;
const MAX_STATIC_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STATIC_TOTAL_BYTES = 64 * 1024 * 1024;
const STATIC_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const INDEX_ENTRY = /\{url:"index\.html",revision:"([a-f0-9]{32})"\}/g;

type StaticRelease = Readonly<{
  files: ReadonlyMap<string, Buffer>;
  indexSha256: string;
  serviceWorkerSha256: string;
}>;

export type HomePwaUpdateRehearsalInput = Readonly<{
  staticRoot: string;
}>;

export type SyntheticPwaPredecessor = Readonly<{
  indexHtml: string;
  serviceWorker: string;
  candidateIndexMd5: string;
  predecessorIndexMd5: string;
}>;

export type StaticGatewayDecision = Readonly<{
  status: 200 | 404 | 405;
  file: string | null;
  contentType: string;
  cacheControl: string;
}>;

export type UpdateRehearsalOperations = Readonly<{
  load(signal: AbortSignal): Promise<void>;
  serve(signal: AbortSignal): Promise<void>;
  launch(signal: AbortSignal): Promise<void>;
  assertPredecessor(signal: AbortSignal): Promise<void>;
  saveLocalCapture(signal: AbortSignal): Promise<void>;
  publishCandidate(signal: AbortSignal): Promise<void>;
  assertWaiting(signal: AbortSignal): Promise<void>;
  activateUpdate(signal: AbortSignal): Promise<void>;
  assertSurvival(signal: AbortSignal): Promise<void>;
  emergencyClose(): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}>;

type UpdatePhase =
  | "load"
  | "serve"
  | "launch"
  | "predecessor"
  | "local-capture"
  | "publish"
  | "waiting"
  | "activate"
  | "survival"
  | "cleanup";

type UpdateDeadlines = Readonly<{ phaseMs: number; cleanupMs: number }>;

/**
 * Artifact-bound PWA update evidence. This owns a single isolated static
 * origin and an ephemeral Chrome context; it never starts or proxies Home.
 */
export async function runHomePwaUpdateRehearsal(
  input: HomePwaUpdateRehearsalInput,
): Promise<void> {
  let candidate: StaticRelease | null = null;
  let predecessor: StaticRelease | null = null;
  let gateway: StaticReleaseGateway | null = null;
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let capture: StoredCapture | null = null;
  let closeInFlight: Promise<void> | null = null;

  const requireCandidate = (): StaticRelease => {
    if (candidate === null) throw new Error("candidate release is unavailable");
    return candidate;
  };
  const requireGateway = (): StaticReleaseGateway => {
    if (gateway === null) throw new Error("static gateway is unavailable");
    return gateway;
  };
  const requirePage = (): Page => {
    if (page === null) throw new Error("browser page is unavailable");
    return page;
  };
  const closeResources = async (clearCapture: boolean): Promise<void> => {
    const closeHandles = async (): Promise<void> => {
      let failed = false;
      if (context !== null) {
        try { await withDeadline(() => context!.close(), HANDLE_CLOSE_TIMEOUT_MS); }
        catch { failed = true; }
        context = null;
        page = null;
      }
      if (browser !== null) {
        try { await withDeadline(() => browser!.close(), HANDLE_CLOSE_TIMEOUT_MS); }
        catch { failed = true; }
        browser = null;
        page = null;
      }
      if (gateway !== null) {
        try { await withDeadline(() => gateway!.close(), HANDLE_CLOSE_TIMEOUT_MS); }
        catch { failed = true; }
        gateway = null;
      }
      if (failed) throw new Error("ephemeral update rehearsal cleanup failed");
    };
    try {
      if (closeInFlight === null) {
        const owned = closeHandles();
        closeInFlight = owned;
        try { await owned; }
        finally { if (closeInFlight === owned) closeInFlight = null; }
      } else {
        await closeInFlight;
      }
    } finally {
      if (clearCapture) capture = null;
    }
  };

  await exerciseHomePwaUpdateRehearsalForTests({
    load: async (signal) => {
      signal.throwIfAborted();
      candidate = await loadStaticRelease(input.staticRoot);
      const synthetic = synthesizePwaPredecessorForTests(
        textFile(candidate, "index.html"),
        textFile(candidate, "sw.js"),
      );
      const files = new Map(candidate.files);
      files.set("index.html", Buffer.from(synthetic.indexHtml));
      files.set("sw.js", Buffer.from(synthetic.serviceWorker));
      predecessor = releaseFromFiles(files);
      assertOnlySyntheticFilesDiffer(candidate, predecessor);
      signal.throwIfAborted();
    },
    serve: async (signal) => {
      signal.throwIfAborted();
      if (predecessor === null) throw new Error("synthetic predecessor is unavailable");
      gateway = await StaticReleaseGateway.open(predecessor, requireCandidate());
      signal.throwIfAborted();
    },
    launch: async (signal) => {
      signal.throwIfAborted();
      try {
        browser = await chromium.launch({ channel: "chrome", headless: true, timeout: WAIT_MS });
      } catch {
        throw new Error("installed system Google Chrome stable channel is unavailable");
      }
      signal.throwIfAborted();
      context = await browser.newContext({ serviceWorkers: "allow", acceptDownloads: false });
      const origin = requireGateway().origin;
      await context.route("**/*", async (route) => {
        let sameOrigin = false;
        try { sameOrigin = new URL(route.request().url()).origin === origin; }
        catch { /* malformed browser URLs remain denied */ }
        if (sameOrigin) await route.continue();
        else await route.abort("blockedbyclient");
      });
      await context.addCookies([{
        name: "dome_csrf",
        value: "pwa-update-rehearsal-local-evidence",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Strict",
      }]);
      page = await context.newPage();
      await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: WAIT_MS });
      signal.throwIfAborted();
    },
    assertPredecessor: async (signal) => {
      const activePage = requirePage();
      await activePage.getByRole("region", { name: "Connection needs a refresh", exact: true })
        .waitFor({ timeout: WAIT_MS });
      await waitForServiceWorkerControl(activePage);
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await activePage.waitForFunction(markerExpression(true), undefined, { timeout: WAIT_MS });
      signal.throwIfAborted();
    },
    saveLocalCapture: async (signal) => {
      const activePage = requirePage();
      await activePage.getByLabel("ask or capture").fill(CAPTURE_TEXT);
      await activePage.getByRole("button", { name: "Capture" }).click();
      await activePage.getByRole("button", { name: "File it" }).click();
      await activePage.getByText("1 queued", { exact: true }).waitFor({ timeout: WAIT_MS });
      capture = await readOnlyCapture(activePage);
      assertCapture(capture, CAPTURE_TEXT);
      signal.throwIfAborted();
    },
    publishCandidate: async (signal) => {
      signal.throwIfAborted();
      requireGateway().publishCandidate();
      const updated = await requirePage().evaluate(`navigator.serviceWorker.getRegistration()
        .then((registration) => {
          if (!registration) return false;
          return registration.update().then(() => true);
        })`);
      if (updated !== true) throw new Error("service worker registration is unavailable");
      signal.throwIfAborted();
    },
    assertWaiting: async (signal) => {
      const activePage = requirePage();
      await activePage.getByText("A Dome update is ready.", { exact: true }).waitFor({ timeout: WAIT_MS });
      const state = await activePage.evaluate(`navigator.serviceWorker.getRegistration().then((registration) => ({
        waiting: registration?.waiting !== null && registration?.waiting !== undefined,
        oldControllerActive: registration?.active === navigator.serviceWorker.controller,
        marked: document.querySelector('meta[name="dome-rehearsal-generation"]')?.getAttribute("content") === "synthetic-predecessor"
      }))`) as { waiting: boolean; oldControllerActive: boolean; marked: boolean };
      if (!state.waiting || !state.oldControllerActive || !state.marked) {
        throw new Error("candidate did not remain waiting behind the active predecessor");
      }
      signal.throwIfAborted();
    },
    activateUpdate: async (signal) => {
      const activePage = requirePage();
      await activePage.evaluate(`sessionStorage.setItem("dome-rehearsal-controllerchange", "armed");
        navigator.serviceWorker.addEventListener("controllerchange", () => {
          sessionStorage.setItem("dome-rehearsal-controllerchange", "observed");
        }, { once: true })`);
      // Arm the reload observer before the click. A DOM poll created after the
      // click races the controllerchange reload and loses its execution context.
      const reloaded = activePage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await Promise.all([
        reloaded,
        activePage.getByRole("button", { name: "Update now" }).click(),
      ]);
      const activated = await activePage.evaluate(`({
        controllerchange: sessionStorage.getItem("dome-rehearsal-controllerchange"),
        marked: document.querySelector('meta[name="dome-rehearsal-generation"]') !== null
      })`) as { controllerchange: string | null; marked: boolean };
      if (activated.controllerchange !== "observed" || activated.marked) {
        throw new Error("candidate document did not settle after controllerchange");
      }
      signal.throwIfAborted();
    },
    assertSurvival: async (signal) => {
      const activePage = requirePage();
      const registrationSettled = await activePage.evaluate(`navigator.serviceWorker.getRegistration()
        .then((registration) => registration !== undefined && registration.waiting === null)`);
      if (registrationSettled !== true) throw new Error("activated registration retained a waiting worker");
      await assertBrowserCandidateBytes(activePage, requireCandidate());
      const survived = await readOnlyCapture(activePage);
      if (capture === null || JSON.stringify(survived) !== JSON.stringify(capture)) {
        throw new Error("local capture row changed during activation");
      }
      assertCapture(survived, CAPTURE_TEXT);
      const remove = activePage.getByRole("button", { name: `delete pending capture ${capture.id}` });
      await remove.waitFor({ timeout: WAIT_MS });
      await remove.click();
      await activePage.getByText("1 queued", { exact: true })
        .waitFor({ state: "hidden", timeout: WAIT_MS });
      await waitForNoCaptures(activePage);
      signal.throwIfAborted();
    },
    emergencyClose: async () => { await closeResources(false); },
    close: async (signal) => {
      signal.throwIfAborted();
      await closeResources(true);
    },
  });
}

/** Pure generation seam. The candidate revision must describe its exact index. */
export function synthesizePwaPredecessorForTests(
  candidateIndexHtml: string,
  candidateServiceWorker: string,
): SyntheticPwaPredecessor {
  if (candidateIndexHtml.includes(GENERATION_MARKER) ||
    candidateIndexHtml.includes('name="dome-rehearsal-generation"')) {
    throw new Error("candidate index already contains the rehearsal marker");
  }
  const headClosures = candidateIndexHtml.match(/<\/head>/g) ?? [];
  if (headClosures.length !== 1) throw new Error("candidate index must contain one head closure");
  const candidateIndexMd5 = digest("md5", Buffer.from(candidateIndexHtml));
  const matches = [...candidateServiceWorker.matchAll(INDEX_ENTRY)];
  if (matches.length !== 1) throw new Error("candidate service worker must contain one index revision");
  if (matches[0]?.[1] !== candidateIndexMd5) {
    throw new Error("candidate service worker index revision does not match candidate bytes");
  }
  const indexHtml = candidateIndexHtml.replace("</head>", `${GENERATION_MARKER}</head>`);
  const predecessorIndexMd5 = digest("md5", Buffer.from(indexHtml));
  const exactEntry = matches[0]?.[0];
  if (exactEntry === undefined) throw new Error("candidate index revision is unavailable");
  const replacement = exactEntry.replace(candidateIndexMd5, predecessorIndexMd5);
  const serviceWorker = candidateServiceWorker.replace(exactEntry, replacement);
  if (serviceWorker === candidateServiceWorker ||
    serviceWorker.split(predecessorIndexMd5).length - 1 !== 1) {
    throw new Error("synthetic predecessor revision replacement was not singular");
  }
  return Object.freeze({
    indexHtml,
    serviceWorker,
    candidateIndexMd5,
    predecessorIndexMd5,
  });
}

/** Pure request-policy seam used by the real static gateway. */
export function decidePwaStaticRequestForTests(
  method: string,
  rawPathname: string,
  knownFiles: readonly string[],
): StaticGatewayDecision {
  if (method !== "GET" && method !== "HEAD") return decision(405, null);
  let pathname: string;
  try { pathname = decodeURIComponent(rawPathname); }
  catch { return decision(404, null); }
  if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("//")) {
    return decision(404, null);
  }
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!STATIC_NAME.test(file) || file.split("/").some((part) => part === "." || part === "..") ||
    !knownFiles.includes(file)) return decision(404, null);
  return decision(200, file);
}

/** Portable orchestration seam. Successful return is explicitly not evidence. */
export async function exerciseHomePwaUpdateRehearsalForTests(
  operations: UpdateRehearsalOperations,
  deadlines: UpdateDeadlines = { phaseMs: PHASE_TIMEOUT_MS, cleanupMs: CLEANUP_TIMEOUT_MS },
): Promise<void> {
  let failure: Error | null = null;
  const phases: readonly [UpdatePhase, (signal: AbortSignal) => Promise<void>][] = [
    ["load", operations.load],
    ["serve", operations.serve],
    ["launch", operations.launch],
    ["predecessor", operations.assertPredecessor],
    ["local-capture", operations.saveLocalCapture],
    ["publish", operations.publishCandidate],
    ["waiting", operations.assertWaiting],
    ["activate", operations.activateUpdate],
    ["survival", operations.assertSurvival],
  ];
  try {
    for (const [phase, operation] of phases) {
      await runPhase(phase, operation, deadlines.phaseMs, operations.emergencyClose, deadlines.cleanupMs);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error("Home PWA update rehearsal failed");
  }
  try {
    await runPhase("cleanup", operations.close, deadlines.cleanupMs, operations.emergencyClose,
      deadlines.cleanupMs);
  } catch (error) {
    if (failure === null) failure = error instanceof Error ? error : new Error("Home PWA update rehearsal cleanup failed");
  }
  if (failure !== null) throw failure;
}

class StaticReleaseGateway {
  private current: StaticRelease;
  private readonly server: Server;
  readonly origin: string;

  private constructor(server: Server, origin: string, predecessor: StaticRelease) {
    this.server = server;
    this.origin = origin;
    this.current = predecessor;
  }

  static async open(predecessor: StaticRelease, candidate: StaticRelease): Promise<StaticReleaseGateway> {
    let gateway: StaticReleaseGateway | null = null;
    const server = createServer((request, response) => {
      if (gateway === null) {
        respond(response, decision(404, null), null, request.method === "HEAD");
        return;
      }
      const pathname = safeRequestPathname(request.url);
      const release = gateway.current;
      const route = decidePwaStaticRequestForTests(
        request.method ?? "GET",
        pathname,
        [...release.files.keys()],
      );
      respond(response, route, route.file === null ? null : release.files.get(route.file) ?? null,
        request.method === "HEAD");
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("static gateway did not bind a loopback port");
    }
    gateway = new StaticReleaseGateway(server, `http://127.0.0.1:${address.port}`, predecessor);
    gateway.candidate = candidate;
    return gateway;
  }

  private candidate: StaticRelease | null = null;

  publishCandidate(): void {
    if (this.candidate === null) throw new Error("candidate release is unavailable");
    // One assignment is the complete N -> N+1 publication transaction.
    this.current = this.candidate;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((error) => error === undefined ? resolvePromise() : reject(error));
      this.server.closeAllConnections();
    });
  }
}

async function loadStaticRelease(staticRoot: string): Promise<StaticRelease> {
  const rootInfo = await lstat(staticRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("candidate static root must be a real directory");
  }
  const canonicalRoot = await realpath(staticRoot);
  const files = new Map<string, Buffer>();
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const contained = relative(canonicalRoot, absolute);
      if (contained === "" || contained.startsWith(`..${sep}`) || contained === ".." || resolve(absolute) !== absolute) {
        throw new Error("candidate static inventory escaped its root");
      }
      const name = contained.split(sep).join("/");
      if (!STATIC_NAME.test(name)) throw new Error("candidate static inventory contains an unsafe name");
      const info = await lstat(absolute);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new Error("candidate static inventory contains a symlink");
      }
      if (entry.isDirectory() && info.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!entry.isFile() || !info.isFile()) {
        throw new Error("candidate static inventory contains a non-file entry");
      }
      if (files.size >= MAX_STATIC_FILES) throw new Error("candidate static inventory exceeds its file bound");
      if (info.size > MAX_STATIC_FILE_BYTES) {
        throw new Error("candidate static file exceeds its shape bound");
      }
      const bytes = Buffer.from(await readFile(absolute));
      const after = await lstat(absolute);
      if (!after.isFile() || after.isSymbolicLink() || after.dev !== info.dev ||
        after.ino !== info.ino || after.size !== info.size || bytes.byteLength !== info.size) {
        throw new Error("candidate static inventory changed while loading");
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_STATIC_TOTAL_BYTES) throw new Error("candidate static inventory exceeds its byte bound");
      files.set(name, bytes);
    }
  };
  await visit(canonicalRoot);
  if (!files.has("index.html") || !files.has("sw.js")) {
    throw new Error("candidate static inventory is missing index.html or sw.js");
  }
  return releaseFromFiles(files);
}

function releaseFromFiles(files: Map<string, Buffer>): StaticRelease {
  const owned = new Map<string, Buffer>();
  for (const [name, bytes] of files) owned.set(name, Buffer.from(bytes));
  const index = owned.get("index.html");
  const worker = owned.get("sw.js");
  if (index === undefined || worker === undefined) throw new Error("static release is incomplete");
  return Object.freeze({
    files: owned as ReadonlyMap<string, Buffer>,
    indexSha256: digest("sha256", index),
    serviceWorkerSha256: digest("sha256", worker),
  });
}

function assertOnlySyntheticFilesDiffer(candidate: StaticRelease, predecessor: StaticRelease): void {
  if (candidate.files.size !== predecessor.files.size) throw new Error("synthetic inventory shape changed");
  for (const [name, bytes] of candidate.files) {
    const prior = predecessor.files.get(name);
    if (prior === undefined) throw new Error("synthetic inventory lost a candidate file");
    if (name !== "index.html" && name !== "sw.js" && !prior.equals(bytes)) {
      throw new Error("synthetic predecessor changed a non-generation file");
    }
  }
  const candidateIndex = candidate.files.get("index.html");
  const predecessorIndex = predecessor.files.get("index.html");
  const candidateWorker = candidate.files.get("sw.js");
  const predecessorWorker = predecessor.files.get("sw.js");
  if (candidateIndex === undefined || predecessorIndex === undefined ||
    candidateWorker === undefined || predecessorWorker === undefined ||
    candidateIndex.equals(predecessorIndex) || candidateWorker.equals(predecessorWorker)) {
    throw new Error("synthetic predecessor did not change both generation files");
  }
}

function textFile(release: StaticRelease, name: string): string {
  const bytes = release.files.get(name);
  if (bytes === undefined) throw new Error(`static release is missing ${name}`);
  return bytes.toString("utf8");
}

function digest(algorithm: "md5" | "sha256", bytes: Buffer): string {
  return createHash(algorithm).update(bytes).digest("hex");
}

function decision(status: 200 | 404 | 405, file: string | null): StaticGatewayDecision {
  return Object.freeze({
    status,
    file,
    contentType: file === null ? "text/plain; charset=utf-8" : contentType(file),
    cacheControl: file === null || file === "index.html" || file === "sw.js" ||
      file.endsWith(".webmanifest") || file.endsWith(".json")
      ? "no-store"
      : "public, max-age=31536000, immutable",
  });
}

function contentType(file: string): string {
  if (file === "sw.js" || extname(file) === ".js") return "text/javascript; charset=utf-8";
  switch (extname(file)) {
    case ".html": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".webmanifest": return "application/manifest+json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".ico": return "image/x-icon";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function safeRequestPathname(rawUrl: string | undefined): string {
  try { return new URL(rawUrl ?? "/", "http://127.0.0.1").pathname; }
  catch { return "/__invalid__"; }
}

function respond(
  response: ServerResponse,
  route: StaticGatewayDecision,
  bytes: Buffer | null,
  head: boolean,
): void {
  response.statusCode = route.status;
  response.setHeader("content-type", route.contentType);
  response.setHeader("cache-control", route.cacheControl);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'");
  if (route.status === 405) response.setHeader("allow", "GET, HEAD");
  if (route.status === 200 && bytes !== null) {
    response.setHeader("content-length", String(bytes.byteLength));
    response.end(head ? undefined : bytes);
    return;
  }
  const body = Buffer.from(route.status === 405 ? "method not allowed\n" : "not found\n");
  response.setHeader("content-length", String(body.byteLength));
  response.end(head ? undefined : body);
}

function markerExpression(expected: boolean): string {
  const expression = `document.querySelector('meta[name="dome-rehearsal-generation"]')?.getAttribute("content") === "synthetic-predecessor"`;
  return expected ? expression : `!(${expression})`;
}

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  const ready = await page.evaluate(`Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ${WAIT_MS}))
  ])`);
  if (ready !== true) throw new Error("synthetic predecessor service worker did not become ready");
  await page.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
  await page.waitForFunction("navigator.serviceWorker.controller !== null", undefined, { timeout: WAIT_MS });
}

type StoredCapture = Readonly<{
  id: string;
  text: string;
  createdAt: string;
  vaultId: string | null;
  state: string;
  attempts: number;
}>;

async function readOnlyCapture(page: Page): Promise<StoredCapture> {
  const rows = await page.evaluate(readCaptureRowsExpression()) as unknown[];
  if (rows.length !== 1) throw new Error("expected exactly one local capture row");
  const row = rows[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("local capture row is malformed");
  const value = row as Record<string, unknown>;
  if (JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify(["attempts", "createdAt", "id", "state", "text", "vaultId"])) {
    throw new Error("local capture row has unexpected fields");
  }
  if (typeof value.id !== "string" || typeof value.text !== "string" ||
    typeof value.createdAt !== "string" || typeof value.state !== "string" ||
    (typeof value.vaultId !== "string" && value.vaultId !== null) ||
    typeof value.attempts !== "number") throw new Error("local capture row has invalid fields");
  return Object.freeze({
    id: value.id,
    text: value.text,
    createdAt: value.createdAt,
    vaultId: value.vaultId,
    state: value.state,
    attempts: value.attempts,
  });
}

async function countCaptures(page: Page): Promise<number> {
  const rows = await page.evaluate(readCaptureRowsExpression()) as unknown[];
  return rows.length;
}

async function waitForNoCaptures(page: Page): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (await countCaptures(page) === 0) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("local capture cleanup did not settle");
}

function readCaptureRowsExpression(): string {
  return `new Promise((resolve, reject) => {
    const request = indexedDB.open("dome-pwa", 1);
    request.onerror = () => reject(new Error("capture database open failed"));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("captures", "readonly");
      const rows = transaction.objectStore("captures").getAll();
      rows.onerror = () => reject(new Error("capture database read failed"));
      rows.onsuccess = () => resolve(rows.result);
      transaction.oncomplete = () => database.close();
    };
  })`;
}

function assertCapture(capture: StoredCapture, expectedText: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(capture.id) || capture.text !== expectedText ||
    capture.state !== "saved-locally" || capture.attempts !== 0 ||
    typeof capture.vaultId !== "string" || capture.vaultId.length === 0 ||
    !Number.isFinite(Date.parse(capture.createdAt))) {
    throw new Error("local capture does not match the saved IndexedDB row");
  }
}

async function assertBrowserCandidateBytes(page: Page, candidate: StaticRelease): Promise<void> {
  const hashes = await page.evaluate(`Promise.all(["/", "/sw.js"].map(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) throw new Error("candidate byte fetch failed");
    const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }))`) as string[];
  if (hashes.length !== 2 || hashes[0] !== candidate.indexSha256 ||
    hashes[1] !== candidate.serviceWorkerSha256) {
    throw new Error("browser-fetched candidate bytes do not match the extracted artifact");
  }
}

async function runPhase(
  phase: UpdatePhase,
  operation: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
  emergencyClose: () => Promise<void>,
  settlementMs: number = CLEANUP_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("timeout"));
    }, timeoutMs);
  });
  try {
    await Promise.race([operationPromise, timeout]);
  } catch {
    controller.abort();
    const emergencySettlement = Promise.resolve().then(emergencyClose).catch(() => undefined);
    try {
      await withDeadline(
        async () => { await Promise.all([operationPromise.catch(() => undefined), emergencySettlement]); },
        settlementMs,
      );
    } catch { /* phase-only diagnostics intentionally hide cleanup internals */ }
    throw new Error(`Home PWA update rehearsal failed during ${phase}`);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("operation exceeded its deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
