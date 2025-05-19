import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    alias: {
      '@dome/common': path.resolve(__dirname, '../../packages/common/src'),
      '@dome/errors': path.resolve(__dirname, '../../packages/errors/src'),
      '@dome/todos': path.resolve(__dirname, '../todos/src'),
      '@dome/silo': path.resolve(__dirname, '../silo/src'),
    },
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'tests/'],
      provider: 'v8',
    },
  },
})
