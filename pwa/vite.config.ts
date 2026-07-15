import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA, type VitePWAOptions } from "vite-plugin-pwa";

const API = "http://127.0.0.1:3663";
const proxy = Object.fromEntries(
  [
    "/sessions",
    "/capture",
    "/tasks",
    "/recents",
    "/resolve",
    "/settle",
    "/transcribe",
    "/healthz",
    "/readyz",
    "/pair",
    "/doc",
    "/source",
  ].map(
    (p) => [p, { target: API, changeOrigin: true }],
  ),
);

export const PWA_OPTIONS = {
  registerType: "prompt",
  injectRegister: false,
  manifest: {
    name: "Dome",
    short_name: "Dome",
    description: "Your private Dome Home knowledge companion.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [],
  },
  workbox: {
    // The plugin adds its generated manifest; this inventory adds only
    // shell code/style/HTML so every precache URL appears exactly once.
    globPatterns: ["**/*.{js,css,html}"],
    navigateFallback: "/index.html",
    navigateFallbackAllowlist: [/^\/$/],
    runtimeCaching: [],
    cleanupOutdatedCaches: true,
  },
} satisfies Partial<VitePWAOptions>;

export default defineConfig({
  plugins: [
    react(),
    VitePWA(PWA_OPTIONS),
  ],
  base: "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { port: 5173, proxy },
});
