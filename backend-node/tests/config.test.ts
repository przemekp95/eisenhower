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

  it('rejects host-selected static auth in production', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: 'production-api-token-at-least-32-characters',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
      MONGODB_URI: 'mongodb://mongodb:27017/eisenhower',
      AI_SERVICE_URL: 'http://ai-service:8000',
    })).toThrow('Production requires AUTH_MODE=oidc.');
  });

  it('rejects an unknown authentication mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'disabled' })).toThrow(
      'AUTH_MODE must be static or oidc.'
    );
  });

  it('rejects every production static token regardless of strength', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: 'too-short',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
      MONGODB_URI: 'mongodb://mongodb:27017/eisenhower',
      AI_SERVICE_URL: 'http://ai-service:8000',
    })).toThrow('Production requires AUTH_MODE=oidc.');
  });

  it('rejects an empty production CORS allowlist', () => {
    expect(() => loadConfig({
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_AUDIENCE: 'eisenhower-api',
      OIDC_JWKS_URL: 'https://identity.example.com/jwks',
      CORS_ALLOW_ORIGINS: ' , ',
      MONGODB_URI: 'mongodb://mongodb:27017/eisenhower',
      AI_SERVICE_URL: 'http://ai-service:8000',
    })).toThrow('CORS_ALLOW_ORIGINS is required in production.');
  });

  it.each(['0', '-1', '1.5', 'not-a-port', '65536'])(
    'rejects invalid PORT %s',
    (port) => {
      expect(() => loadConfig({ PORT: port })).toThrow('PORT must be an integer from 1 to 65535.');
    },
  );

  it('requires explicit database, AI, and CORS configuration in production', () => {
    const base = {
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_AUDIENCE: 'eisenhower-api',
      OIDC_JWKS_URL: 'https://identity.example.com/jwks',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
      MONGODB_URI: 'mongodb://mongodb:27017/eisenhower',
      AI_SERVICE_URL: 'http://ai-service:8000',
    };

    expect(() => loadConfig({ ...base, MONGODB_URI: '' })).toThrow('MONGODB_URI is required in production.');
    expect(() => loadConfig({ ...base, AI_SERVICE_URL: '' })).toThrow('AI_SERVICE_URL is required in production.');
    expect(() => loadConfig({ ...base, CORS_ALLOW_ORIGINS: undefined })).toThrow(
      'CORS_ALLOW_ORIGINS is required in production.',
    );
  });

  it('rejects malformed production service URLs and browser origins', () => {
    const base = {
      NODE_ENV: 'production',
      AUTH_MODE: 'oidc',
      OIDC_ISSUER: 'https://identity.example.com',
      OIDC_AUDIENCE: 'eisenhower-api',
      OIDC_JWKS_URL: 'https://identity.example.com/jwks',
      CORS_ALLOW_ORIGINS: 'https://app.example.com',
      MONGODB_URI: 'mongodb://mongodb:27017/eisenhower',
      AI_SERVICE_URL: 'http://ai-service:8000',
    };

    expect(() => loadConfig({ ...base, MONGODB_URI: 'file:///tmp/tasks' })).toThrow(
      'MONGODB_URI must use mongodb or mongodb+srv.',
    );
    expect(() => loadConfig({ ...base, AI_SERVICE_URL: 'not-a-url' })).toThrow(
      'AI_SERVICE_URL must be an absolute HTTP(S) URL.',
    );
    expect(() => loadConfig({ ...base, CORS_ALLOW_ORIGINS: 'http://app.example.com' })).toThrow(
      'Production CORS origins must use HTTPS.',
    );
    expect(() => loadConfig({ ...base, CORS_ALLOW_ORIGINS: 'https://app.example.com/path' })).toThrow(
      'CORS_ALLOW_ORIGINS entries must be origins without paths, queries, or fragments.',
    );
  });

  it('rejects malformed URLs across every configuration parser branch', () => {
    expect(() => loadConfig({ MONGODB_URI: 'not-a-url' })).toThrow(
      'MONGODB_URI must be an absolute MongoDB URL.',
    );
    expect(() => loadConfig({ AI_SERVICE_URL: 'ftp://ai.example.com' })).toThrow(
      'AI_SERVICE_URL must be an absolute HTTP(S) URL.',
    );
    expect(() => loadConfig({ AI_SERVICE_URL: 'https://user:secret@ai.example.com' })).toThrow(
      'AI_SERVICE_URL must not include credentials.',
    );
    expect(() => loadConfig({ AI_SERVICE_URL: 'https://ai.example.com?health=ready' })).toThrow(
      'AI_SERVICE_URL must not include a query or fragment.',
    );
    expect(() => loadConfig({ CORS_ALLOW_ORIGINS: 'not-a-url' })).toThrow(
      'CORS_ALLOW_ORIGINS entries must be absolute HTTP(S) origins.',
    );
    expect(() => loadConfig({ CORS_ALLOW_ORIGINS: 'ftp://app.example.com' })).toThrow(
      'CORS_ALLOW_ORIGINS entries must be absolute HTTP(S) origins.',
    );
    expect(() => loadConfig({ NODE_ENV: 'staging' })).toThrow(
      'NODE_ENV must be development, test, or production.',
    );
  });
});
