export interface AppConfig {
  port: number;
  mongodbUri: string;
  aiServiceUrl: string;
  nodeEnv: string;
  authMode: 'static' | 'oidc';
  apiToken: string;
  oidcIssuer: string | null;
  oidcAudience: string | null;
  oidcJwksUrl: string | null;
  corsAllowOrigins: string[];
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
  const mongodbUri = production
    ? requiredProductionValue(env, 'MONGODB_URI')
    : (env.MONGODB_URI?.trim() || DEFAULT_MONGO_URI);
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
    mongodbUri: validateMongoUri(mongodbUri),
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
