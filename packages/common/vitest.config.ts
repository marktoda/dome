import { defineConfig } from 'vitest/config';

export default defineConfig({
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
