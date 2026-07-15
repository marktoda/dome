import { chromium, type Browser, type BrowserContext, type Download, type Page } from "playwright-core";
import type { InstalledFunctionalCanary } from "./home-installed-functional-closure";

const DEVICE_NAME = "Dome installed Chromium acceptance";
const REPAIRED_DEVICE_NAME = "Dome installed Chromium acceptance repaired";
const CAPTURE_TEXT = "Dome installed Chromium offline capture canary";
const WAIT_MS = 15_000;
const PHASE_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 15_000;
const HANDLE_CLOSE_TIMEOUT_MS = 5_000;
const MAX_EXPORT_BYTES = 64 * 1024;

export type HomePwaChromiumAcceptanceInput = Readonly<{
  baseUrl: string;
  expected: Readonly<{
    productVersion: string;
    vaultName: string;
    functionalCanary: InstalledFunctionalCanary;
  }>;
  mintPairingCode: (deviceName: string, signal: AbortSignal) => Promise<string>;
  revokeDevice: (deviceName: string, signal: AbortSignal) => Promise<void>;
  assertLogicalCapture: (text: string, captureId: string, signal: AbortSignal) => Promise<void>;
  assertTaskSettlement: (commit: string, signal: AbortSignal) => Promise<void>;
}>;

type AcceptancePhase =
  | "launch"
  | "pair"
  | "readiness"
  | "adaptive-accessibility"
  | "service-worker"
  | "activity-source"
  | "task-settlement"
  | "offline-shell"
  | "local-capture"
  | "revoke"
  | "auth-repair"
  | "replay"
  | "cleanup";

type AcceptanceOperations = Readonly<{
  launch(signal: AbortSignal): Promise<void>;
  pair(signal: AbortSignal): Promise<void>;
  assertReadiness(signal: AbortSignal): Promise<void>;
  assertAdaptiveAccessibility(signal: AbortSignal): Promise<void>;
  controlServiceWorker(signal: AbortSignal): Promise<void>;
  assertActivitySource(signal: AbortSignal): Promise<void>;
  assertTaskSettlement(signal: AbortSignal): Promise<void>;
  assertOfflineShell(signal: AbortSignal): Promise<void>;
  saveLocalCapture(signal: AbortSignal): Promise<void>;
  revoke(signal: AbortSignal): Promise<void>;
  repairAuthentication(signal: AbortSignal): Promise<void>;
  assertReplay(signal: AbortSignal): Promise<void>;
  emergencyClose(): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
}>;

type AcceptanceDeadlines = Readonly<{
  phaseMs: number;
  cleanupMs: number;
}>;

/**
 * Exercise the shipped PWA through the installed system Google Chrome stable
 * channel. The runner
 * deliberately creates no trace, HAR, video, screenshot, or storage-state
 * artifact: the paired cookie and queued capture live only in one ephemeral
 * browser context, which is destroyed before returning.
 */
export async function runHomePwaChromiumAcceptance(
  input: HomePwaChromiumAcceptanceInput,
): Promise<void> {
  const baseUrl = installedLoopbackUrl(input.baseUrl);
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let firstCode = "";
  let repairCode = "";
  let captureId = "";
  let closeInFlight: Promise<void> | null = null;

  const requirePage = (): Page => {
    if (page === null) throw new Error("browser page is unavailable");
    return page;
  };
  const requireContext = (): BrowserContext => {
    if (context === null) throw new Error("browser context is unavailable");
    return context;
  };
  const closeBrowser = async (clearSecrets: boolean): Promise<void> => {
    const closeHandles = async (): Promise<void> => {
      let failed = false;
      if (context !== null) {
        try {
          await withDeadline(() => context!.close(), HANDLE_CLOSE_TIMEOUT_MS);
          context = null;
          page = null;
        } catch { failed = true; }
      }
      if (browser !== null) {
        try {
          await withDeadline(() => browser!.close(), HANDLE_CLOSE_TIMEOUT_MS);
          browser = null;
          page = null;
        } catch { failed = true; }
      }
      if (failed) throw new Error("ephemeral Chrome cleanup failed");
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
      if (clearSecrets) {
        firstCode = "";
        repairCode = "";
        captureId = "";
      }
    }
  };

  await runAcceptanceSequence({
    launch: async (signal) => {
      signal.throwIfAborted();
      try {
        browser = await chromium.launch({ channel: "chrome", headless: true, timeout: WAIT_MS });
      } catch {
        throw new Error("installed system Google Chrome stable channel is unavailable");
      }
      signal.throwIfAborted();
      // These are the complete context options. In particular, there is no
      // recordHar, recordVideo, storageState, or persistent user-data path.
      context = await browser.newContext({ serviceWorkers: "allow", acceptDownloads: true });
      await context.route("**/*", async (route) => {
        let sameOrigin = false;
        try { sameOrigin = new URL(route.request().url()).origin === baseUrl.origin; }
        catch { /* malformed browser URL remains denied */ }
        if (sameOrigin) await route.continue();
        else await route.abort("blockedbyclient");
      });
      page = await context.newPage();
      await page.goto(baseUrl.href, { waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await assertInstallIdentity(page);
      signal.throwIfAborted();
    },
    pair: async (signal) => {
      firstCode = await input.mintPairingCode(DEVICE_NAME, signal);
      signal.throwIfAborted();
      const activePage = requirePage();
      await activePage.getByLabel("Pairing code").fill(firstCode);
      await activePage.getByRole("button", { name: "Pair device" }).click();
      signal.throwIfAborted();
    },
    assertReadiness: async (signal) => {
      await assertReadyConnection(requirePage(), input.expected, DEVICE_NAME);
      signal.throwIfAborted();
    },
    assertAdaptiveAccessibility: async (signal) => {
      await assertAdaptiveAccessibility(requirePage());
      signal.throwIfAborted();
    },
    controlServiceWorker: async (signal) => {
      const activePage = requirePage();
      const registration = await activePage.evaluate(`Promise.race([
        navigator.serviceWorker.ready.then(() => "ready"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), ${WAIT_MS}))
      ])`);
      if (registration !== "ready") throw new Error("service worker registration did not settle");
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await activePage.waitForFunction(
        "navigator.serviceWorker.controller !== null",
        undefined,
        { timeout: WAIT_MS },
      );
      await assertReadyConnection(activePage, input.expected, DEVICE_NAME);
      signal.throwIfAborted();
    },
    assertActivitySource: async (signal) => {
      await assertActivitySource(requirePage(), input.expected.functionalCanary);
      signal.throwIfAborted();
    },
    assertTaskSettlement: async (signal) => {
      const activePage = requirePage();
      const settlementCommit = await settleFunctionalTask(activePage, input.expected.functionalCanary);
      signal.throwIfAborted();
      await input.assertTaskSettlement(settlementCommit, signal);
      signal.throwIfAborted();
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await assertReadyConnection(activePage, input.expected, DEVICE_NAME);
      await activePage.getByRole("checkbox", { name: input.expected.functionalCanary.taskText })
        .waitFor({ state: "detached", timeout: WAIT_MS });
      signal.throwIfAborted();
    },
    assertOfflineShell: async (signal) => {
      const activeContext = requireContext();
      const activePage = requirePage();
      await activeContext.setOffline(true);
      await activePage.reload({ waitUntil: "domcontentloaded", timeout: WAIT_MS });
      await activePage.getByText("Offline", { exact: true }).waitFor({ timeout: WAIT_MS });
      if (!await activePage.getByRole("button", { name: "send" }).isDisabled()) {
        throw new Error("Ask remained enabled offline");
      }
      const readinessResolved = await activePage.evaluate(`fetch("/readyz", { cache: "no-store" })
        .then((response) => ({ resolved: true, status: response.status }))
        .catch(() => ({ resolved: false, status: 0 }))`) as { readonly resolved: boolean };
      if (readinessResolved.resolved) throw new Error("readiness was served while offline");
      signal.throwIfAborted();
    },
    saveLocalCapture: async (signal) => {
      const activePage = requirePage();
      await activePage.getByLabel("ask your brain").fill(CAPTURE_TEXT);
      await activePage.getByRole("button", { name: "capture thought" }).click();
      await activePage.getByRole("heading", { name: "Saved locally" }).waitFor({ timeout: WAIT_MS });
      await activePage.getByText("1 saved locally", { exact: true }).waitFor({ timeout: WAIT_MS });
      const exportButton = activePage.getByRole("button", { name: "Export" });
      if (!await exportButton.isEnabled()) throw new Error("pending capture export is unavailable");
      const downloadPromise = activePage.waitForEvent("download", { timeout: WAIT_MS });
      await exportButton.click();
      const download = await downloadPromise;
      if (download.suggestedFilename() !== "dome-pending-captures.json" || await download.failure() !== null) {
        throw new Error("pending capture export failed");
      }
      try {
        captureId = parseHomePwaCaptureExportForTests(
          await readBoundedDownload(download),
          CAPTURE_TEXT,
        );
      } finally {
        await download.delete();
      }
      await activePage.getByRole("heading", { name: "Saved locally" })
        .waitFor({ state: "hidden", timeout: WAIT_MS });
      signal.throwIfAborted();
    },
    revoke: async (signal) => {
      await input.revokeDevice(DEVICE_NAME, signal);
      signal.throwIfAborted();
      await requireContext().setOffline(false);
    },
    repairAuthentication: async (signal) => {
      const activePage = requirePage();
      await activePage.getByText("Pair this device again", { exact: true }).waitFor({ timeout: WAIT_MS });
      await activePage.getByText("1 saved locally", { exact: true }).waitFor({ timeout: WAIT_MS });
      repairCode = await input.mintPairingCode(REPAIRED_DEVICE_NAME, signal);
      signal.throwIfAborted();
      await activePage.getByLabel("New pairing code").fill(repairCode);
      await activePage.getByRole("button", { name: "Pair again" }).click();
      await assertReadyConnection(activePage, input.expected, REPAIRED_DEVICE_NAME);
      signal.throwIfAborted();
    },
    assertReplay: async (signal) => {
      const pending = requirePage().getByText("1 saved locally", { exact: true });
      await pending.waitFor({ state: "hidden", timeout: WAIT_MS });
      if (captureId === "") throw new Error("exported capture identity is unavailable");
      await input.assertLogicalCapture(CAPTURE_TEXT, captureId, signal);
      signal.throwIfAborted();
    },
    emergencyClose: async () => { await closeBrowser(false); },
    close: async (signal) => {
      signal.throwIfAborted();
      await closeBrowser(true);
    },
  });
}

const RESPONSIVE_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 320, height: 568 }),
  Object.freeze({ width: 390, height: 844 }),
  Object.freeze({ width: 844, height: 390 }),
]);
const STABLE_MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844 });

async function assertAdaptiveAccessibility(page: Page): Promise<void> {
  for (const viewport of RESPONSIVE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    const result = await page.evaluate(`(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const inside = (element) => {
        const rect = element.getBoundingClientRect();
        return rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5;
      };
      const enabled = [...document.querySelectorAll("button:not([disabled]), summary, a[href]:not(.wl), input:not([disabled]), textarea:not([disabled])")]
        .filter(visible);
      const undersized = enabled.filter((element) => {
        const target = element.matches('input[type="checkbox"]') ? element.closest(".task-hit") ?? element : element;
        const rect = target.getBoundingClientRect();
        return rect.width < 43.5 || rect.height < 43.5;
      }).map((element) => element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 40) || element.tagName);
      const critical = [".composer", '[aria-label="ask your brain"]', '[aria-label="capture thought"]', '[aria-label="send"]']
        .map((selector) => document.querySelector(selector));
      return {
        overflow: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
        undersized,
        criticalMissing: critical.some((element) => element === null || !visible(element) || !inside(element)),
      };
    })()` ) as { readonly overflow: boolean; readonly undersized: readonly string[]; readonly criticalMissing: boolean };
    if (result.overflow) throw new Error(`installed PWA overflows horizontally at ${viewport.width}x${viewport.height}`);
    if (result.undersized.length > 0) throw new Error(`installed PWA has undersized targets at ${viewport.width}x${viewport.height}`);
    if (result.criticalMissing) throw new Error(`installed PWA critical controls leave the viewport at ${viewport.width}x${viewport.height}`);

    await page.evaluate(`(() => {
      document.body.tabIndex = -1;
      document.body.focus();
      document.body.removeAttribute("tabindex");
    })()`);
    await page.keyboard.press("Tab");
    const focusVisible = await page.evaluate(`(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return false;
      const style = getComputedStyle(active);
      const rect = active.getBoundingClientRect();
      return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) >= 3 &&
        rect.left >= -0.5 && rect.top >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5;
    })()`);
    if (!focusVisible) throw new Error(`installed PWA keyboard focus is not visibly contained at ${viewport.width}x${viewport.height}`);
  }

  await page.emulateMedia({ reducedMotion: "reduce" });
  const motionDisabled = await page.evaluate(`(() => [...document.querySelectorAll("*")].every((element) => {
    const style = getComputedStyle(element);
    const transitions = style.transitionDuration.split(",").every((value) => parseFloat(value) === 0);
    return style.animationName === "none" && transitions && style.scrollBehavior !== "smooth";
  }))()`);
  if (!motionDisabled) throw new Error("installed PWA reduced-motion policy left animation or transition enabled");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize(STABLE_MOBILE_VIEWPORT);
}

async function assertInstallIdentity(page: Page): Promise<void> {
  const identity = await page.evaluate(`(async () => {
    const meta = (name) => document.querySelector('meta[name="' + name + '"]')?.getAttribute("content") ?? null;
    const link = (selector) => document.querySelector(selector)?.getAttribute("href") ?? null;
    const decode = async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    };
    const response = await fetch("/manifest.webmanifest", { cache: "no-store" });
    return {
      metadata: {
        colorScheme: meta("color-scheme"), appleCapable: meta("apple-mobile-web-app-capable"),
        appleStatusBar: meta("apple-mobile-web-app-status-bar-style"), appleTitle: meta("apple-mobile-web-app-title"),
        favicon: link('link[rel="icon"][sizes="48x48"]'), svgIcon: link('link[rel="icon"][sizes="any"]'),
        appleTouch: link('link[rel="apple-touch-icon"]'), manifest: link('link[rel="manifest"]'),
      },
      images: {
        favicon: await decode("/favicon.ico"), svg: await decode("/dome.svg"),
        appleTouch: await decode("/apple-touch-icon-180x180.png"), icon64: await decode("/pwa-64x64.png"),
        icon192: await decode("/pwa-192x192.png"), icon512: await decode("/pwa-512x512.png"),
        maskable512: await decode("/maskable-icon-512x512.png"),
      },
      manifestOk: response.ok,
      manifest: await response.json(),
    };
  })()`) as unknown as {
    readonly metadata: Record<string, string | null>;
    readonly images: Record<string, readonly [number, number]>;
    readonly manifestOk: boolean;
    readonly manifest: unknown;
  };
  if (!identity.manifestOk || JSON.stringify(identity.metadata) !== JSON.stringify({
    colorScheme: "dark",
    appleCapable: "yes",
    appleStatusBar: "black-translucent",
    appleTitle: "Dome",
    favicon: "/favicon.ico",
    svgIcon: "/dome.svg",
    appleTouch: "/apple-touch-icon-180x180.png",
    manifest: "/manifest.webmanifest",
  })) {
    throw new Error("installed PWA platform metadata is incomplete");
  }
  const svg = identity.images["svg"];
  const expectedImages: Readonly<Record<string, readonly [number, number]>> = {
    favicon: [48, 48], appleTouch: [180, 180], icon64: [64, 64], icon192: [192, 192],
    icon512: [512, 512], maskable512: [512, 512],
  };
  if (Object.entries(expectedImages).some(([name, size]) =>
    JSON.stringify(identity.images[name]) !== JSON.stringify(size)
  ) || svg === undefined || svg[0] <= 0 || svg[1] <= 0) {
    throw new Error("installed PWA icon assets did not decode at their declared dimensions");
  }
  const manifest = identity.manifest as Record<string, unknown>;
  if (manifest["id"] !== "/" || manifest["lang"] !== "en" || manifest["start_url"] !== "/" || manifest["scope"] !== "/" ||
    manifest["display"] !== "standalone" || manifest["theme_color"] !== "#111111" ||
    JSON.stringify(manifest["icons"]) !== JSON.stringify([
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png", purpose: "any" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ])) {
    throw new Error("installed PWA manifest identity is incomplete");
  }
}

/** Portable ordering seam. It cannot launch Chrome or return browser evidence. */
export async function exerciseHomePwaChromiumAcceptanceForTests(
  operations: AcceptanceOperations,
  deadlines: Partial<AcceptanceDeadlines> = {},
): Promise<Readonly<{ evidence: false }>> {
  await runAcceptanceSequence(operations, {
    phaseMs: deadlines.phaseMs ?? PHASE_TIMEOUT_MS,
    cleanupMs: deadlines.cleanupMs ?? CLEANUP_TIMEOUT_MS,
  });
  return Object.freeze({ evidence: false });
}

async function runAcceptanceSequence(
  operations: AcceptanceOperations,
  deadlines: AcceptanceDeadlines = { phaseMs: PHASE_TIMEOUT_MS, cleanupMs: CLEANUP_TIMEOUT_MS },
): Promise<void> {
  const steps: ReadonlyArray<readonly [AcceptancePhase, (signal: AbortSignal) => Promise<void>]> = [
    ["launch", operations.launch],
    ["pair", operations.pair],
    ["readiness", operations.assertReadiness],
    ["adaptive-accessibility", operations.assertAdaptiveAccessibility],
    ["service-worker", operations.controlServiceWorker],
    ["activity-source", operations.assertActivitySource],
    ["task-settlement", operations.assertTaskSettlement],
    ["offline-shell", operations.assertOfflineShell],
    ["local-capture", operations.saveLocalCapture],
    ["revoke", operations.revoke],
    ["auth-repair", operations.repairAuthentication],
    ["replay", operations.assertReplay],
  ];
  let failure: AcceptancePhase | null = null;
  let cleanupFailed = false;
  for (const [phase, operation] of steps) {
    const outcome = await runCooperativePhase(
      operation,
      operations.emergencyClose,
      deadlines.phaseMs,
      deadlines.cleanupMs,
    );
    if (!outcome.ok) {
      failure = phase;
      cleanupFailed ||= outcome.emergencyCloseFailed;
      break;
    }
  }
  const cleanup = await runCooperativePhase(
    operations.close,
    operations.emergencyClose,
    deadlines.cleanupMs,
    deadlines.cleanupMs,
  );
  cleanupFailed ||= !cleanup.ok || cleanup.emergencyCloseFailed;
  if (failure !== null) {
    const action = failure === "launch"
      ? "launch or initial shell failed; verify the installed Google Chrome stable channel and Home, then retry"
      : `failed at ${failure}`;
    throw new Error(`installed Home Chromium acceptance ${action}${cleanupFailed ? "; cleanup also failed" : ""}`);
  }
  if (cleanupFailed) throw new Error("installed Home Chromium acceptance cleanup failed");
}

async function runCooperativePhase(
  operation: (signal: AbortSignal) => Promise<void>,
  emergencyClose: () => Promise<void>,
  timeoutMs: number,
  emergencyTimeoutMs: number,
): Promise<Readonly<{ ok: boolean; emergencyCloseFailed: boolean }>> {
  if (!validDeadline(timeoutMs) || !validDeadline(emergencyTimeoutMs)) {
    return Object.freeze({ ok: false, emergencyCloseFailed: true });
  }
  const controller = new AbortController();
  const settlement = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      () => Object.freeze({ ok: true }),
      () => Object.freeze({ ok: false }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutStarted = false;
  const timeout = new Promise<Readonly<{ timedOut: true; emergencyCloseFailed: boolean }>>((resolveTimeout) => {
    timer = setTimeout(() => {
      timeoutStarted = true;
      controller.abort();
      let closing: Promise<void>;
      try { closing = emergencyClose(); }
      catch {
        resolveTimeout(Object.freeze({ timedOut: true, emergencyCloseFailed: true }));
        return;
      }
      void withDeadline(() => closing, emergencyTimeoutMs).then(
        () => resolveTimeout(Object.freeze({ timedOut: true, emergencyCloseFailed: false })),
        () => resolveTimeout(Object.freeze({ timedOut: true, emergencyCloseFailed: true })),
      );
    }, timeoutMs);
  });
  const winner = await Promise.race([
    settlement.then((result) => Object.freeze({ timedOut: false as const, result })),
    timeout,
  ]);
  if (!winner.timedOut) {
    if (timeoutStarted) {
      const timedOut = await timeout;
      return Object.freeze({ ok: false, emergencyCloseFailed: timedOut.emergencyCloseFailed });
    }
    if (timer !== undefined) clearTimeout(timer);
    return Object.freeze({ ok: winner.result.ok, emergencyCloseFailed: false });
  }
  // Timeout is cooperative, not abandon-on-race: abort is visible to host
  // callbacks, emergency close rejects Playwright work, and the losing phase
  // must settle before final cleanup can release scenario ownership.
  await settlement;
  return Object.freeze({ ok: false, emergencyCloseFailed: winner.emergencyCloseFailed });
}

export function parseHomePwaCaptureExportForTests(bytes: Uint8Array, expectedText: string): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_EXPORT_BYTES) {
    throw new Error("pending capture export size is invalid");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("pending capture export is invalid JSON"); }
  const root = exactRecord(value, ["schema", "exported_at", "captures"]);
  if (root["schema"] !== "dome.capture-queue/v1" || !exactTimestamp(root["exported_at"]) ||
    !Array.isArray(root["captures"]) || root["captures"].length !== 1) {
    throw new Error("pending capture export envelope is invalid");
  }
  const capture = exactRecord(root["captures"][0], ["id", "text", "createdAt", "state", "attempts"]);
  if (typeof capture["id"] !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(capture["id"]) ||
    capture["text"] !== expectedText || !exactTimestamp(capture["createdAt"]) ||
    capture["state"] !== "saved-locally" || capture["attempts"] !== 0) {
    throw new Error("pending capture export item is invalid");
  }
  return capture["id"];
}

async function readBoundedDownload(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  if (stream === null) throw new Error("pending capture export stream is unavailable");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    length += chunk.byteLength;
    if (length > MAX_EXPORT_BYTES) {
      stream.destroy();
      throw new Error("pending capture export is oversized");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
}

async function withDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (!validDeadline(timeoutMs)) throw new Error("acceptance deadline is invalid");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("acceptance phase deadline exceeded")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function validDeadline(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function exactRecord(value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pending capture export object is invalid");
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error("pending capture export fields are invalid");
  }
  return record;
}

function exactTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

async function assertReadyConnection(
  page: Page,
  expected: HomePwaChromiumAcceptanceInput["expected"],
  deviceName: string,
): Promise<void> {
  const summary = page.locator("details.connection > summary");
  await summary.filter({ hasText: "Connection · ready" }).waitFor({ timeout: WAIT_MS });
  if (await page.locator("details.connection").getAttribute("open") === null) await summary.click();
  const details = page.locator("details.connection");
  await details.getByText(expected.vaultName, { exact: true }).waitFor({ timeout: WAIT_MS });
  await details.getByText(deviceName, { exact: true }).waitFor({ timeout: WAIT_MS });
  await details.getByText(expected.productVersion, { exact: true }).waitFor({ timeout: WAIT_MS });
  await details.getByText("capture, read, resolve", { exact: true }).waitFor({ timeout: WAIT_MS });
}

async function assertActivitySource(page: Page, canary: InstalledFunctionalCanary): Promise<void> {
  const activity = page.locator("details.recents-wrap");
  if (await activity.getAttribute("open") === null) await activity.locator("summary").click();
  const row = activity.getByRole("button").filter({ hasText: canary.title });
  if (await row.count() !== 1) throw new Error("installed PWA functional Activity row is not unique");
  await row.click();
  const dialog = page.getByRole("dialog", { name: canary.path });
  await dialog.waitFor({ timeout: WAIT_MS });
  await dialog.getByText(`Revision ${canary.commit.slice(0, 8)}`, { exact: true }).waitFor({ timeout: WAIT_MS });
  const source = await dialog.locator("pre").textContent();
  if (source === null || !source.includes(canary.sourceMarker) ||
    !source.includes(`- [ ] ${canary.taskText}`) || !source.includes(`^${canary.blockId}`)) {
    throw new Error("installed PWA source viewer did not return the exact canary content");
  }
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden", timeout: WAIT_MS });
  if (!await row.evaluate("(element) => document.activeElement === element")) {
    throw new Error("installed PWA source viewer did not restore Activity focus");
  }
}

async function settleFunctionalTask(page: Page, canary: InstalledFunctionalCanary): Promise<string> {
  const checkbox = page.getByRole("checkbox", { name: canary.taskText });
  await checkbox.waitFor({ timeout: WAIT_MS });
  if (!await checkbox.isEnabled() || await checkbox.isChecked()) {
    throw new Error("installed PWA functional task was not initially actionable");
  }
  const responsePending = page.waitForResponse((response) => {
    const request = response.request();
    return request.method() === "POST" && new URL(response.url()).pathname === "/settle";
  }, { timeout: WAIT_MS });
  const [response] = await Promise.all([responsePending, checkbox.click()]);
  if (response.status() !== 200) throw new Error("installed PWA functional settlement was not accepted");
  return parseHomePwaSettlementReceiptForTests(await response.json(), canary.blockId);
}

/** Strict portable parser for the one installed functional settlement receipt. */
export function parseHomePwaSettlementReceiptForTests(body: unknown, expectedBlockId: string): string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("installed PWA functional settlement receipt is invalid");
  }
  const receipt = body as Record<string, unknown>;
  if (JSON.stringify(Object.keys(receipt).sort()) !==
      JSON.stringify(["block_id", "commit", "disposition", "schema", "status"].sort()) ||
    receipt["schema"] !== "dome.settle/v1" || receipt["status"] !== "settled" ||
    expectedBlockId.length === 0 || receipt["block_id"] !== expectedBlockId || receipt["disposition"] !== "close" ||
    typeof receipt["commit"] !== "string" || !/^[0-9a-f]{40}$/.test(receipt["commit"])) {
    throw new Error("installed PWA functional settlement receipt is not exact");
  }
  return receipt["commit"];
}

function installedLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" ||
    url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("installed Home Chromium acceptance requires an exact loopback Home URL");
  }
  return url;
}
