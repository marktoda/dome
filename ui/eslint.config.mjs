// eslint.config.ts  (Flat config, ESM)

import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

export default [
  // Next.js defaults
  ...compat.extends('next/core-web-vitals', 'next/typescript'),

  // Global chill-out overrides
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    rules: {
      /* let me experiment without complaints */
      'no-console': 'off',
      'no-explicit-any': 'off',
      'no-debugger': 'off',
      'no-param-reassign': 'off',
      'no-plusplus': 'off',

      /* unused stuff is totally fine */
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',

      /* style nits */
      'prefer-const': 'off',
      'import/prefer-default-export': 'off',
    },
  },
];
