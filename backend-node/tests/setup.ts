import { afterEach, beforeEach, jest } from '@jest/globals';

beforeEach(() => {
  jest.restoreAllMocks();
});

afterEach(() => {
  jest.clearAllMocks();
});
