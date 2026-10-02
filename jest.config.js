module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // The codebase is deliberately mixed JS/TS, so tests are matched in both.
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '**/?(*.)+(spec|test).ts',
    '**/__tests__/**/*.test.js',
    '**/?(*.)+(spec|test).js',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'res/**/*.ts',
    '!res/**/*.d.ts',
    '!res/**/index.ts'
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/res/$1'
  },
  // Several suites are integration tests against a remote database. Connecting
  // through Railway's public proxy alone takes ~4s, so Jest's 5s default left
  // no room for the query itself and timed the hooks out. This is a ceiling,
  // not a wait — the mocked suites still finish in milliseconds.
  testTimeout: 60000
};
