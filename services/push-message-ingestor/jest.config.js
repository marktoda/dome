/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/tests/'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.{ts,js}',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ['text', 'lcov'],
  // Mock Cloudflare Worker environment
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.json',
    },
  },
  // Setup files to mock Cloudflare Worker environment
  setupFiles: ['<rootDir>/tests/setup.js'],
};