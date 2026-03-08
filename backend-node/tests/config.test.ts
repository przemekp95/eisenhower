import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('loads defaults for local development', () => {
    const config = loadConfig({});

    expect(config.port).toBe(3001);
    expect(config.mongodbUri).toBe('mongodb://localhost:27017/eisenhower');
    expect(config.aiServiceUrl).toBe('http://localhost:8000');
    expect(config.jwtSecret).toBeNull();
  });

  it('throws when production misses JWT_SECRET', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'JWT_SECRET must be set in production.'
    );
  });

  it('accepts explicit env overrides', () => {
    const config = loadConfig({
      PORT: '4100',
      MONGODB_URI: 'mongodb://example:27017/test',
      AI_SERVICE_URL: 'http://ai.internal',
      NODE_ENV: 'production',
      JWT_SECRET: 'secret',
    });

    expect(config.port).toBe(4100);
    expect(config.mongodbUri).toContain('example');
    expect(config.aiServiceUrl).toBe('http://ai.internal');
    expect(config.jwtSecret).toBe('secret');
  });
});
