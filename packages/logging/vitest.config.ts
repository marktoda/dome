import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.js'],
    root: '.',
    coverage: {
      provider: 'c8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/*.d.ts'],
    },
    setupFiles: ['./tests/setup.js'],
  },
});