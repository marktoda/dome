import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config';

// Configure vitest to use more memory and run tests serially
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['tests/setup.js'],
      exclude: ['tests/newContentQueue.test.ts', 'tests/sendToDeadLetter.test.ts'],
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
  }),
);
