import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((part) => Number.parseInt(part, 16) / 255) ?? [];
  const [r = 0, g = 0, b = 0] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function token(css: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(css)?.[1];
  if (value === undefined) throw new Error(`missing CSS token --${name}`);
  return value;
}

describe("PWA adaptive accessibility CSS policy", () => {
  test("pins safe axes, dynamic viewport fallbacks, focus, targets, and reduced motion", async () => {
    const css = await readFile(join(import.meta.dir, "..", "src", "styles.css"), "utf8");
    for (const axis of ["top", "right", "bottom", "left"]) {
      expect(css).toContain(`--safe-${axis}: env(safe-area-inset-${axis}, 0px)`);
    }
    expect(css).toMatch(/height:\s*100%;\s*height:\s*100svh;\s*height:\s*100dvh/);
    expect(css).toContain("max-height: min(calc(100dvh");
    expect(css).toContain("var(--safe-left)");
    expect(css).toContain("var(--safe-right)");
    expect(css).toContain(":focus-visible { outline: 3px solid var(--focus)");
    expect(css).toMatch(/button:not\(\[disabled\]\)[\s\S]*min-width:\s*44px;[\s\S]*min-height:\s*44px;/);
    expect(css).toContain(".task-hit { width: 44px; height: 44px;");
    expect(css).toContain("Inline `.wl` prose links are the deliberate text-link exception");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"), css.indexOf("/* ── App shell"));
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain("scroll-behavior: auto !important");
  });

  test("keeps the installed coarse-target audit aligned with the inline text-link exception", async () => {
    const runner = await readFile(join(import.meta.dir, "..", "..", "scripts", "home-pwa-chromium-acceptance.ts"), "utf8");
    expect(runner).toContain('a[href]:not(.wl)');
    expect(runner).not.toContain('summary, a[href], input:not([disabled])');
    expect(runner).toContain("diagnostics.evaluate((element) =>");
    expect(runner).toContain("row.evaluate((element) =>");
    expect(runner).not.toMatch(/\.evaluate\(\s*[`"']\(element\)\s*=>/);
  });

  test("keeps expanded connection diagnostics bounded and independently keyboard-scrollable", async () => {
    const css = await readFile(join(import.meta.dir, "..", "src", "styles.css"), "utf8");
    const connection = css.match(/\.connection\s*\{([^}]*)\}/)?.[1] ?? "";
    const openConnection = css.match(/\.connection\.open\s*\{([^}]*)\}/)?.[1] ?? "";
    const summary = css.match(/\.connection-summary\s*\{([^}]*)\}/)?.[1] ?? "";
    const body = css.match(/\.connection-body\s*\{([^}]*)\}/)?.[1] ?? "";

    expect(connection).toMatch(/flex:\s*0\s+1\s+auto/);
    expect(connection).toMatch(/min-height:\s*44px/);
    expect(connection).toMatch(/overflow:\s*hidden/);
    expect(openConnection).toMatch(/display:\s*flex/);
    expect(openConnection).toMatch(/flex-direction:\s*column/);
    expect(summary).toMatch(/flex:\s*none/);
    expect(body).toMatch(/min-height:\s*0/);
    expect(body).toMatch(/overflow-y:\s*auto/);
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    expect(css).toMatch(/\.connection-body:focus-visible\s*\{[^}]*outline-offset:\s*-3px/);

    const runner = await readFile(join(import.meta.dir, "..", "..", "scripts", "home-pwa-chromium-acceptance.ts"), "utf8");
    expect(runner).toContain('page.keyboard.press("PageDown")');
    expect(runner).toContain("installed PWA connection diagnostics did not receive keyboard focus");
    expect(runner).toContain("installed PWA connection diagnostics did not keyboard-scroll");
    expect(runner).toContain("installed PWA connection summary or focus left the viewport during keyboard scroll");
  });

  test("keeps compact Today refresh inside its surface and in the installed containment audit", async () => {
    const css = await readFile(join(import.meta.dir, "..", "src", "styles.css"), "utf8");
    const app = await readFile(join(import.meta.dir, "..", "src", "App.tsx"), "utf8");
    const refresh = css.match(/\.surface-refresh\s*\{([^}]*)\}/)?.[1] ?? "";
    const button = css.match(/\.surface-refresh button\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(css).not.toContain(".today-refresh");
    expect(css).toMatch(/\.today-panel\s*\{[^}]*border-top/);
    expect(refresh).toMatch(/min-height:\s*44px/);
    expect(refresh).toMatch(/flex-wrap:\s*wrap/);
    expect(button).toMatch(/min-height:\s*44px/);
    expect(app).toContain('const visibleTodayRefreshState: TodayRefreshState = access.read ? todayRefreshState : "idle"');
    expect(app).toContain('aria-busy={visibleTodayRefreshState === "loading"}');
    expect(app).toContain('className={`today-panel ${visibleTodayRefreshState}`} aria-label="Today"');
    expect(app).not.toContain('aria-label="Today refresh"');
    expect(app).toContain('role="status"');
    expect(app).toContain('aria-live="polite"');
    expect(app).toContain('aria-atomic="true"');

    const runner = await readFile(join(
      import.meta.dir, "..", "..", "scripts", "home-pwa-chromium-acceptance.ts",
    ), "utf8");
    expect(runner).toContain("'[aria-label=\"Today\"]'");
    expect(runner).toContain("installed PWA critical controls leave the viewport");
  });

  test("secondary text and interactive boundaries meet their contrast floors", async () => {
    const css = await readFile(join(import.meta.dir, "..", "src", "styles.css"), "utf8");
    const background = token(css, "bg-screen");
    expect(contrast(token(css, "text-faint"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(css, "label"), background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token(css, "control-border"), token(css, "input"))).toBeGreaterThanOrEqual(3);
    expect(css).not.toMatch(/\.source-close[^{}]*:focus-visible[^{}]*\{[^}]*outline:\s*1px/i);
  });
});
