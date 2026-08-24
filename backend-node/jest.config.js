module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/server.ts',
    // Nest decorators and Fastify glue are exercised by the exact HTTP contract
    // harness and BDD suite. Istanbul reports synthetic decorator branches, so
    // the 100% unit-coverage gate remains focused on executable application,
    // domain, persistence, and provider logic.
    '!src/app.ts',
    '!src/app.module.ts',
    '!src/modules/**/*.controller.ts',
    '!src/modules/**/*.module.ts',
    '!src/modules/**/*.guard.ts',
    '!src/modules/**/*.decorators.ts',
    '!src/modules/tasks/*dto.ts',
    '!src/modules/tasks/task-validation.pipe.ts',
    '!src/platform/http/**/*.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  testTimeout: 30000,
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
};
