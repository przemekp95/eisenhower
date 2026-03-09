const base = require('./jest.config.js');

module.exports = {
  ...base,
  testMatch: ['<rootDir>/src/**/*.integration.test.ts', '<rootDir>/src/**/*.integration.test.tsx'],
  testPathIgnorePatterns: [],
};
