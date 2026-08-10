import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('loads defaults for local development', () => {
    const config = loadConfig({});

    expect(config.port).toBe(3001);
    expect(config.mongodbUri).toBe('mongodb://localhost:27017/eisenhower');
    expect(config.aiServiceUrl).toBe('http://localhost:8000');
    expect(config.authMode).toBe('static');
  });

  it('throws when production misses OIDC configuration', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(
      'OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL are required for OIDC auth.'
    );
  });

  it('accepts explicit env overrides', () => {
    const config = loadConfig({
      PORT: '4100',
      MONGODB_URI: 'mongodb://example:27017/test',
      AI_SERVICE_URL: 'http://ai.internal',
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_AUDIENCE: 'eisenhower-api',
      OIDC_JWKS_URL: 'https://identity.example.com/.well-known/jwks.json',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
    });

    expect(config.port).toBe(4100);
    expect(config.mongodbUri).toContain('example');
    expect(config.aiServiceUrl).toBe('http://ai.internal');
    expect(config.authMode).toBe('oidc');
  });

  it('keeps strong static bearer auth available for existing production deployments', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: 'production-api-token-at-least-32-characters',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
    });

    expect(config.authMode).toBe('static');
  });

  it('rejects an unknown authentication mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'disabled' })).toThrow(
      'AUTH_MODE must be static or oidc.'
    );
  });

  it('rejects a weak production static token', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: 'too-short',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
    })).toThrow('EISENHOWER_API_TOKEN must be at least 32 characters in production.');
  });

  it('rejects an empty production CORS allowlist', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: 'production-api-token-at-least-32-characters',
      CORS_ALLOW_ORIGINS: ' , ',
    })).toThrow('CORS_ALLOW_ORIGINS is required in production.');
  });
});
