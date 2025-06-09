import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/mockData',
        '**/__mocks__',
      ],
    },
    include: ['packages/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
    testTimeout: 20000,
    hookTimeout: 20000,
  },
  resolve: {
    alias: {
      '@dome2/shared': resolve(__dirname, './packages/shared/src'),
      '@dome2/connectors': resolve(__dirname, './packages/connectors'),
      '@dome2/core': resolve(__dirname, './packages/core'),
      '@dome2/agent': resolve(__dirname, './packages/agent'),
      '@dome2/api': resolve(__dirname, './packages/api'),
    },
  },
});
