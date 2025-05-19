import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['**/*.test.ts', '**/*.test.js'],
      root: '.',
      setupFiles: ['./vitest.setup.js'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['src/**/*.{ts,js}'],
        exclude: ['src/**/*.d.ts'],
      },
    },
  }),
);
