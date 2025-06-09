import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/hono/index.ts', 'src/trpc/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
});
