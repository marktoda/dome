import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://127.0.0.1:4664";
const proxy = Object.fromEntries(
  ["/ask", "/ask/stream", "/capture", "/tasks", "/recents", "/resolve", "/transcribe", "/healthz"].map(
    (p) => [p, { target: API, changeOrigin: true }],
  ),
);

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist",
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { port: 5173, proxy },
});
