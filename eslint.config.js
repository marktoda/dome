import parserTypescript from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';

// Minimal stub for react-hooks plugin to silence rule reference without full dependency
const reactHooksPlugin = {
  rules: {
    // no-op implementations
    'rules-of-hooks': { create: () => ({}), meta: {} },
    'exhaustive-deps': { create: () => ({}), meta: {} },
  },
};

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  // Ignore patterns (replaces .eslintignore)
  {
    ignores: ['dist', 'node_modules', '.direnv', '.nix'],
  },

  // Basic recommended rules for JavaScript
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        NodeJS: 'readonly',
        require: 'readonly',
        module: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'error',
      'no-undef': 'error',
    },
  },

  // TypeScript-specific configuration
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: parserTypescript,
      parserOptions: {
        project: ['./tsconfig.json'],
        sourceType: 'module',
        ecmaVersion: 2022,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
      'unused-imports': unusedImportsPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      // Disable unused vars & imports checks for now (too noisy)
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'off',
      'no-unused-vars': 'off',
      // The import plugin has limited understanding of TS path aliases/extensions; disable unresolved errors.
      'import/no-unresolved': 'off',
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  // Global linter options
  {
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
  },
];
