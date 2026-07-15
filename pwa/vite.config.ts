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
    lang: "en",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#111111",
    theme_color: "#111111",
    icons: [
      { src: "pwa-64x64.png", sizes: "64x64", type: "image/png", purpose: "any" },
      { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  },
  workbox: {
    // The plugin adds its manifest and manifest icons; this inventory adds
    // shell code/style/HTML plus non-manifest head icons exactly once.
    globPatterns: [
      "**/*.{js,css,html}",
      "favicon.ico",
      "dome.svg",
      "apple-touch-icon-180x180.png",
      // Manifest icons are added to this inventory by vite-plugin-pwa.
      // Repeating them here would emit duplicate precache entries.
    ],
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
