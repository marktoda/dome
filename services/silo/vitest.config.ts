import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    alias: {
      '@dome/common': path.resolve(__dirname, '../../packages/common/src'),
      '@dome/errors': path.resolve(__dirname, '../../packages/errors/src'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json', 'html'],
      include: ['src/**/*.{ts,js}'],
      exclude: ['src/**/*.d.ts', 'tests/**'],
    },
  },
})
