import { defineConfig } from 'vitest/config';

// Configure vitest to use more memory and run tests serially
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    setupFiles: ['tests/setup.js'],
    // Run tests serially to reduce memory pressure
    singleThread: true,
    // Increase Node.js memory limit using the runner process args
    testTimeout: 30000, // Increase test timeout to allow for garbage collection
    hookTimeout: 30000,
    // Using process.env is one of the reliable ways to increase Node.js heap size
    environmentOptions: {
      env: {
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
    },
    // Allow garbage collector to run between tests
    teardownTimeout: 5000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json', 'html'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/*.d.ts', 'tests/**'],
    },
  },
});
