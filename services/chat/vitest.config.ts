import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    alias: {
      '@dome/common': path.resolve(__dirname, '../../packages/common/src'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['node_modules/', 'tests/', 'src/**/*.d.ts'],
    },
  },
});
