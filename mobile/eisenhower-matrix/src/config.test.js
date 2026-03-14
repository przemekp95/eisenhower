describe('mobile config', () => {
  const originalEnv = process.env;
  const originalDev = global.__DEV__;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    process.env.NODE_ENV = 'test';
    global.__DEV__ = true;
    delete process.env.EXPO_PUBLIC_APP_ORIGIN_URL;
    delete process.env.EXPO_PUBLIC_API_URL;
    delete process.env.EXPO_PUBLIC_AI_API_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
    global.__DEV__ = originalDev;
  });

  it('defaults to local development urls when no Expo variables are set', () => {
    const { mobileConfig } = require('./config');

    expect(mobileConfig).toEqual({
      appOrigin: null,
      apiUrl: 'http://127.0.0.1:3001',
      aiApiUrl: 'http://127.0.0.1:8000',
    });
  });

  it('derives API urls from a shared production origin', () => {
    process.env.EXPO_PUBLIC_APP_ORIGIN_URL = 'https://example.com/';

    const { mobileConfig } = require('./config');

    expect(mobileConfig).toEqual({
      appOrigin: 'https://example.com',
      apiUrl: 'https://example.com/api',
      aiApiUrl: 'https://example.com/ai',
    });
  });

  it('lets explicit API urls override the shared origin', () => {
    process.env.EXPO_PUBLIC_APP_ORIGIN_URL = 'https://example.com';
    process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com';
    process.env.EXPO_PUBLIC_AI_API_URL = 'https://ai.example.com';

    const { mobileConfig } = require('./config');

    expect(mobileConfig).toEqual({
      appOrigin: 'https://example.com',
      apiUrl: 'https://api.example.com',
      aiApiUrl: 'https://ai.example.com',
    });
  });

  it('rejects an empty EXPO_PUBLIC_API_URL value', () => {
    process.env.EXPO_PUBLIC_API_URL = '   ';

    expect(() => require('./config')).toThrow(
      'EXPO_PUBLIC_API_URL must not be empty when provided.'
    );
  });

  it('rejects an empty EXPO_PUBLIC_AI_API_URL value', () => {
    process.env.EXPO_PUBLIC_AI_API_URL = '';

    expect(() => require('./config')).toThrow(
      'EXPO_PUBLIC_AI_API_URL must not be empty when provided.'
    );
  });

  it('requires public urls in production builds', () => {
    process.env.NODE_ENV = 'production';
    global.__DEV__ = false;

    expect(() => require('./config')).toThrow(
      'EXPO_PUBLIC_API_URL or EXPO_PUBLIC_APP_ORIGIN_URL is required in production builds.'
    );
  });
});
