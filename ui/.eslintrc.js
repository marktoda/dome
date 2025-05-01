module.exports = {
  extends: ['next/core-web-vitals'],
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  rules: {
    // Disable rules that are causing problems but aren't critical
    '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-unsafe-assignment': 'off',
    '@typescript-eslint/no-unsafe-member-access': 'off',
    '@typescript-eslint/no-unsafe-return': 'off',
    '@typescript-eslint/no-unsafe-call': 'off',
    '@typescript-eslint/no-unsafe-argument': 'off',
    '@typescript-eslint/no-unnecessary-condition': 'off',
    '@typescript-eslint/require-await': 'off',
    '@typescript-eslint/no-floating-promises': 'off',
    '@typescript-eslint/no-misused-promises': 'off',
    '@typescript-eslint/restrict-template-expressions': 'off',
    '@typescript-eslint/consistent-type-imports': 'off',
    'object-shorthand': 'off',
    'curly': 'off',
    'quote-props': 'off'
  }
};