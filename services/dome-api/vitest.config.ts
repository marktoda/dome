import { defineConfig } from 'vitest/config';
import path from 'path';

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
    alias: {
      // Corrected assumption: 'packages' is a sibling of 'services' under the monorepo root,
      // OR 'packages' is directly under the monorepo root 'dome'.
      // If monorepo root is /home/toda/dev/dome/, and packages is /home/toda/dev/dome/packages/
      // then from /home/toda/dev/dome/services/dome-api/, the path is ../../packages/common/src
      '@dome/common': path.resolve(__dirname, '../../packages/common/src'),
      // Assuming 'chat' is a service sibling to 'dome-api': /home/toda/dev/dome/services/chat
      '@dome/chat/client': path.resolve(__dirname, '../chat/src/client'),
      // Assuming 'silo' is a service sibling to 'dome-api': /home/toda/dev/dome/services/silo
      '@dome/silo/client': path.resolve(__dirname, '../silo/src/client'),
      // Assuming 'constellation' is a service sibling to 'dome-api': /home/toda/dev/dome/services/constellation
      '@dome/constellation/client': path.resolve(__dirname, '../constellation/src/client'),
      // Assuming 'ai-processor' is a service sibling to 'dome-api': /home/toda/dev/dome/services/ai-processor
      '@dome/ai-processor/client': path.resolve(__dirname, '../ai-processor/src/client'),
      // Assuming 'tsunami' is a service sibling to 'dome-api': /home/toda/dev/dome/services/tsunami
      '@dome/tsunami/client': path.resolve(__dirname, '../tsunami/src/client'),
      // Re-adding alias for @dome/logging, pointing to the package root
      // Assumes 'packages/logging' exists at ../../packages/logging from dome-api
      '@dome/logging': path.resolve(__dirname, '../../packages/logging'),
    },
  },
});

