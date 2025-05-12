import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.js'],
    root: '.',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/*.d.ts'],
    },
    setupFiles: ['./vitest.setup.js'],
    alias: {
      '@dome/common': path.resolve(__dirname, '../common/src'),
    },
  },
});
