module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: 'module',
    project: './tsconfig.json',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  rules: {
    // Error prevention
    'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    'no-return-await': 'error',
    'no-promise-executor-return': 'error',
    'no-template-curly-in-string': 'error',
    'no-unreachable-loop': 'error',
    'no-unused-private-class-members': 'error',
    'require-atomic-updates': 'error',

    // TypeScript specific
    '@typescript-eslint/explicit-module-boundary-types': 'error',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    '@typescript-eslint/consistent-type-imports': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-unnecessary-condition': 'warn',

    // Style
    'arrow-body-style': ['error', 'as-needed'],
    curly: ['error', 'all'],
    eqeqeq: ['error', 'always'],
    'prefer-const': 'error',
    'prefer-arrow-callback': 'error',
    'object-shorthand': 'error',
    'quote-props': ['error', 'as-needed'],
    'no-else-return': 'error',
  },
  ignorePatterns: ['dist', 'node_modules', '*.js', '!.eslintrc.js'],
  env: {
    node: true,
    es2020: true,
  },
};
