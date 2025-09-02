import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      OPENAI_API_KEY: 'test-key-for-tests',
      POSTGRES_URI: 'postgresql://test:test@localhost:5432/test',
      LOG_LEVEL: 'error'
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.config.{js,ts}',
        '**/*.test.{js,ts}',
        '**/*.spec.{js,ts}'
      ]
    },
    include: ['src/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./src/tests/setup.ts']
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, './src/core'),
      '@cli': path.resolve(__dirname, './src/cli'),
      '@mastra': path.resolve(__dirname, './src/mastra'),
      '@watcher': path.resolve(__dirname, './src/watcher')
    }
  }
});