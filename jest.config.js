module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
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
