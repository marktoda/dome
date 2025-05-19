import { defineConfig } from 'vitest/config';
import fs from 'node:fs';
import path from 'path';

const tsconfig = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'tsconfig.json'), 'utf8'),
);

const alias: Record<string, string> = {};
for (const [key, paths] of Object.entries(
  tsconfig.compilerOptions.paths as Record<string, string[]>,
)) {
  alias[key.replace(/\/*$/, '')] = path.resolve(
    __dirname,
    paths[0].replace(/\/*$/, ''),
  );
}

export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    globals: true,
    setupFiles: [path.resolve(__dirname, 'tests/setup.ts')],
  },
});
