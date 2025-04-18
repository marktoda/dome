/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/tests/'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.{ts,js}', '!src/**/*.d.ts'],
  coverageReporters: ['text', 'lcov'],
  // Setup files to mock Cloudflare Worker environment
  setupFiles: ['<rootDir>/tests/setup.js'],
  // Fix for "Cannot read properties of undefined (reading 'isTTY')"
  testEnvironmentOptions: {
    customExportConditions: ['node', 'node-addons'],
  },
  // Avoid interactive mode issues
  forceExit: true,
  detectOpenHandles: true,
  // Silence verbose logs
  verbose: false,
  silent: true,
};
