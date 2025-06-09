export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // New feature
        'fix', // Bug fix
        'docs', // Documentation changes
        'style', // Code style changes (formatting, etc)
        'refactor', // Code refactoring
        'perf', // Performance improvements
        'test', // Adding or updating tests
        'build', // Build system changes
        'ci', // CI/CD changes
        'chore', // Other changes that don't modify src or test files
        'revert', // Revert a previous commit
      ],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'shared',
        'connectors',
        'core',
        'agent',
        'api',
        'docker',
        'deps',
        'config',
        'github',
        'notion',
        'slack',
        'linear',
        'kafka',
        'vector-store',
        'embeddings',
        'rag',
        'langgraph',
        'fastify',
        'trpc',
      ],
    ],
    'subject-case': [2, 'always', 'lower-case'],
    'header-max-length': [2, 'always', 100],
  },
};
