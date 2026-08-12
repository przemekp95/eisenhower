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

  it('falls back to NODE_ENV when the React Native development flag is unavailable', () => {
    delete global.__DEV__;

    const { mobileConfig } = require('./config');

    expect(mobileConfig.apiUrl).toBe('http://127.0.0.1:3001');
    expect(mobileConfig.aiApiUrl).toBe('http://127.0.0.1:8000');
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

  it.each([
    ['EXPO_PUBLIC_API_URL', 'not-a-url', 'must be an absolute HTTP(S) URL'],
    ['EXPO_PUBLIC_API_URL', 'ftp://api.example.com', 'must be an absolute HTTP(S) URL'],
    ['EXPO_PUBLIC_API_URL', 'http://api.example.com', 'must use HTTPS in production builds'],
    ['EXPO_PUBLIC_API_URL', 'https://user:pass@api.example.com', 'must not include credentials'],
    ['EXPO_PUBLIC_API_URL', 'https://api.example.com/tasks?all=true', 'must not include a query or fragment'],
    ['EXPO_PUBLIC_AI_API_URL', 'https://ai.example.com/#status', 'must not include a query or fragment'],
    ['EXPO_PUBLIC_API_URL', 'https://127.0.0.1/api', 'must not use a loopback or emulator host'],
    ['EXPO_PUBLIC_API_URL', 'https://10.0.2.2/api', 'must not use a loopback or emulator host'],
  ])('rejects unsafe production %s value %s', (name, value, message) => {
    process.env.NODE_ENV = 'production';
    global.__DEV__ = false;
    process.env.EXPO_PUBLIC_API_URL = 'https://api.example.com';
    process.env.EXPO_PUBLIC_AI_API_URL = 'https://ai.example.com';
    process.env[name] = value;

    expect(() => require('./config')).toThrow(`${name} ${message}.`);
  });

  it('requires the shared production value to be an origin without a path', () => {
    process.env.NODE_ENV = 'production';
    global.__DEV__ = false;
    process.env.EXPO_PUBLIC_APP_ORIGIN_URL = 'https://example.com/nested';

    expect(() => require('./config')).toThrow(
      'EXPO_PUBLIC_APP_ORIGIN_URL must be an origin without a path, query, or fragment.'
    );
  });
});
