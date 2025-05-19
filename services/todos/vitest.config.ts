import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    alias: {
      '@dome/common': path.resolve(__dirname, '../../packages/common/src'),
    },
    setupFiles: ['tests/setup.js'],
  },
});
