import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('loads defaults for local development', () => {
    const config = loadConfig({ EISENHOWER_API_TOKEN: 'development-token' });

    expect(config.port).toBe(3001);
    expect(config.mongodbUri).toBe('mongodb://localhost:27017/eisenhower');
    expect(config.aiServiceUrl).toBe('http://localhost:8000');
    expect(config.apiToken).toBe('development-token');
  });

  it('throws when production misses EISENHOWER_API_TOKEN', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'EISENHOWER_API_TOKEN must be set in production.'
    );
  });

  it('accepts explicit env overrides', () => {
    const config = loadConfig({
      PORT: '4100',
      MONGODB_URI: 'mongodb://example:27017/test',
      AI_SERVICE_URL: 'http://ai.internal',
      NODE_ENV: 'production',
      EISENHOWER_API_TOKEN: 'test-api-token-that-is-long-enough',
      CORS_ALLOW_ORIGINS: 'https://tasks.example.com,https://mobile.example.com',
    });

    expect(config.port).toBe(4100);
    expect(config.mongodbUri).toContain('example');
    expect(config.aiServiceUrl).toBe('http://ai.internal');
    expect(config.apiToken).toBe('test-api-token-that-is-long-enough');
    expect(config.corsAllowOrigins).toEqual([
      'https://tasks.example.com',
      'https://mobile.example.com',
    ]);
  });

  it('rejects short production API tokens', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', EISENHOWER_API_TOKEN: 'too-short' })
    ).toThrow('EISENHOWER_API_TOKEN must be at least 32 characters in production.');
  });

  it('requires an explicit browser origin allowlist in production', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        EISENHOWER_API_TOKEN: 'test-api-token-that-is-long-enough',
        CORS_ALLOW_ORIGINS: '',
      })
    ).toThrow('CORS_ALLOW_ORIGINS must list at least one trusted frontend origin in production.');
  });

  it('requires an API token outside tests too', () => {
    expect(() => loadConfig({ NODE_ENV: 'development' })).toThrow(
      'EISENHOWER_API_TOKEN must be set outside tests.'
    );
  });

  it('drops empty CORS entries after trimming', () => {
    const config = loadConfig({
      EISENHOWER_API_TOKEN: 'development-token',
      CORS_ALLOW_ORIGINS: ' https://tasks.example.com, ,',
    });

    expect(config.corsAllowOrigins).toEqual(['https://tasks.example.com']);
  });
});
