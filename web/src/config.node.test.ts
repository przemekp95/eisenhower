/** @jest-environment node */

describe('runtimeConfig in a node runtime', () => {
  const originalApiUrl = process.env.VITE_API_URL;
  const originalAiApiUrl = process.env.VITE_AI_API_URL;

  afterEach(() => {
    if (originalApiUrl === undefined) {
      delete process.env.VITE_API_URL;
    } else {
      process.env.VITE_API_URL = originalApiUrl;
    }

    if (originalAiApiUrl === undefined) {
      delete process.env.VITE_AI_API_URL;
    } else {
      process.env.VITE_AI_API_URL = originalAiApiUrl;
    }

    jest.resetModules();
  });

  it('reads VITE urls without window access', async () => {
    process.env.VITE_API_URL = 'http://node-api.test';
    process.env.VITE_AI_API_URL = 'http://node-ai.test';

    const { runtimeConfig } = await import('./config');

    expect(runtimeConfig).toEqual({
      apiUrl: 'http://node-api.test',
      aiApiUrl: 'http://node-ai.test',
    });
  });
});
