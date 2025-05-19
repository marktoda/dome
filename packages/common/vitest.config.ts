import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config';

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['**/*.test.ts', '**/*.test.js'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['src/**/*.{ts,js}'],
        exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.d.ts'],
      },
    },
  }),
);
