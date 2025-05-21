import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/**/*.test.ts'],
      setupFiles: ['tests/setup.ts'],
      exclude: ['tests/queue.test.ts'],
      coverage: {
        reporter: ['text', 'json', 'html'],
        exclude: ['node_modules/', 'tests/'],
        provider: 'v8',
      },
    },
  }),
);
