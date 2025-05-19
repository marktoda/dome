import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@dome/common': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.d.ts'],
    },
  },
});
