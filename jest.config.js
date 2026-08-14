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
  }
};
