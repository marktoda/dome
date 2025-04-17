/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/tests/'],
  testMatch: ['**/*.test.ts', '**/*.test.js'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.{ts,js}', '!src/**/*.d.ts'],
  coverageReporters: ['text', 'lcov'],
  // Setup files to mock Cloudflare Worker environment
  setupFiles: ['<rootDir>/tests/setup.js'],
  // Map the import to the TypeScript source
  moduleNameMapper: {
    '^@dome/common$': '<rootDir>/../../packages/common/src',
  },
}
