export interface AppConfig {
  port: number;
  databaseProvider: 'mongodb' | 'postgresql';
  mongodbUri: string;
  postgresql: PostgresConnectionSettings | null;
  redisUrl: string | null;
  aiServiceUrl: string;
  nodeEnv: string;
  authMode: 'static' | 'oidc';
  apiToken: string;
  oidcIssuer: string | null;
  oidcAudience: string | null;
  oidcJwksUrl: string | null;
  corsAllowOrigins: string[];
}

export interface PostgresConnectionSettings {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean;
}

const DEFAULT_MONGO_URI = 'mongodb://localhost:27017/eisenhower';
const DEFAULT_AI_URL = 'http://localhost:8000';
const DEFAULT_PORT = 3001;
const VALID_NODE_ENVIRONMENTS = new Set(['development', 'test', 'production']);

function requiredProductionValue(
  env: NodeJS.ProcessEnv,
  name: 'MONGODB_URI' | 'AI_SERVICE_URL' | 'CORS_ALLOW_ORIGINS',
) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required in production.`);
  }
  return value;
}

function loadPostgresSettings(env: NodeJS.ProcessEnv): PostgresConnectionSettings {
  const names = [
    'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_NAME', 'DATABASE_USERNAME', 'DATABASE_PASSWORD',
  ] as const;
  const values = Object.fromEntries(names.map((name) => [name, env[name]?.trim() ?? ''])) as Record<(typeof names)[number], string>;
  if (names.some((name) => !values[name])) {
    throw new Error('DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USERNAME and DATABASE_PASSWORD are required for PostgreSQL.');
  }
  if (!/^[A-Za-z0-9.-]+$/.test(values.DATABASE_HOST)) {
    throw new Error('DATABASE_HOST must be a DNS name or IP address without URL syntax.');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(values.DATABASE_NAME)) {
    throw new Error('DATABASE_NAME contains unsupported characters.');
  }
  return {
    host: values.DATABASE_HOST,
    port: parsePort(values.DATABASE_PORT),
    database: values.DATABASE_NAME,
    username: values.DATABASE_USERNAME,
    password: values.DATABASE_PASSWORD,
    ssl: env.DATABASE_SSL?.trim() !== 'false',
  };
}

function loadRedisUrl(env: NodeJS.ProcessEnv, production: boolean) {
  if (env.REDIS_ENABLED?.trim() !== 'true') return null;
  const host = env.REDIS_HOST?.trim() ?? '';
  const port = env.REDIS_PORT?.trim() ?? '';
  const token = env.REDIS_AUTH_TOKEN?.trim() ?? '';
  if (!host || !port || !token) {
    throw new Error('REDIS_HOST, REDIS_PORT and REDIS_AUTH_TOKEN are required when Redis is enabled.');
  }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error('REDIS_HOST must be a DNS name or IP address without URL syntax.');
  }
  const tls = env.REDIS_TLS?.trim() !== 'false';
  if (production && !tls) throw new Error('Production Redis must use TLS.');
  return `${tls ? 'rediss' : 'redis'}://:${encodeURIComponent(token)}@${host}:${parsePort(port)}`;
}

function parsePort(value: string | undefined) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function validateMongoUri(value: string) {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch {
    throw new Error('MONGODB_URI must be an absolute MongoDB URL.');
  }
  if (!['mongodb:', 'mongodb+srv:'].includes(uri.protocol)) {
    throw new Error('MONGODB_URI must use mongodb or mongodb+srv.');
  }
  return value;
}

function validateHttpUrl(value: string, name: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${name} must not include a query or fragment.`);
  }
  return value.replace(/\/+$/, '');
}

function validateCorsOrigin(value: string, production: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CORS_ALLOW_ORIGINS entries must be absolute HTTP(S) origins.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('CORS_ALLOW_ORIGINS entries must be absolute HTTP(S) origins.');
  }
  if (production && url.protocol !== 'https:') {
    throw new Error('Production CORS origins must use HTTPS.');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('CORS_ALLOW_ORIGINS entries must be origins without paths, queries, or fragments.');
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!VALID_NODE_ENVIRONMENTS.has(nodeEnv)) {
    throw new Error('NODE_ENV must be development, test, or production.');
  }
  const production = nodeEnv === 'production';
  const databaseProvider = (env.DATABASE_PROVIDER?.trim() || 'mongodb') as 'mongodb' | 'postgresql';
  if (!['mongodb', 'postgresql'].includes(databaseProvider)) {
    throw new Error('DATABASE_PROVIDER must be mongodb or postgresql.');
  }
  const authMode = (env.AUTH_MODE?.trim() ?? (production ? 'oidc' : 'static')) as 'static' | 'oidc';
  const apiToken = (env.EISENHOWER_API_TOKEN ?? (production ? '' : 'test-api-token')).trim();
  const oidcIssuer = env.OIDC_ISSUER?.trim() || null;
  const oidcAudience = env.OIDC_AUDIENCE?.trim() || null;
  const oidcJwksUrl = env.OIDC_JWKS_URL?.trim() || null;
  if (!['static', 'oidc'].includes(authMode)) {
    throw new Error('AUTH_MODE must be static or oidc.');
  }
  if (production && authMode !== 'oidc') {
    throw new Error('Production requires AUTH_MODE=oidc.');
  }
  if (authMode === 'oidc' && !(oidcIssuer && oidcAudience && oidcJwksUrl)) {
    throw new Error('OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL are required for OIDC auth.');
  }
  if (authMode === 'static' && production && apiToken.length < 32) {
    throw new Error('EISENHOWER_API_TOKEN must be at least 32 characters in production.');
  }
  const mongodbUri = production && databaseProvider === 'mongodb'
    ? requiredProductionValue(env, 'MONGODB_URI')
    : (env.MONGODB_URI?.trim() || DEFAULT_MONGO_URI);
  const postgresql = databaseProvider === 'postgresql' ? loadPostgresSettings(env) : null;
  const redisUrl = loadRedisUrl(env, production);
  const aiServiceUrl = production
    ? requiredProductionValue(env, 'AI_SERVICE_URL')
    : (env.AI_SERVICE_URL?.trim() || DEFAULT_AI_URL);
  const corsValue = production
    ? requiredProductionValue(env, 'CORS_ALLOW_ORIGINS')
    : (env.CORS_ALLOW_ORIGINS ?? 'http://localhost:3000,http://localhost:5173');
  const corsAllowOrigins = corsValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => validateCorsOrigin(value, production));

  if (production && corsAllowOrigins.length === 0) {
    throw new Error('CORS_ALLOW_ORIGINS is required in production.');
  }

  return {
    port: parsePort(env.PORT),
    databaseProvider,
    mongodbUri: validateMongoUri(mongodbUri),
    postgresql,
    redisUrl,
    aiServiceUrl: validateHttpUrl(aiServiceUrl, 'AI_SERVICE_URL'),
    nodeEnv,
    authMode,
    apiToken,
    oidcIssuer,
    oidcAudience,
    oidcJwksUrl,
    corsAllowOrigins,
  };
}
