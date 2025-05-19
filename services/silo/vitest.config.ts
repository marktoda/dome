import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov', 'json', 'html'],
        include: ['src/**/*.{ts,js}'],
        exclude: ['src/**/*.d.ts', 'tests/**'],
      },
    },
  }),
);
