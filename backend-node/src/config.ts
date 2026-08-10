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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const authMode = (env.AUTH_MODE ?? (nodeEnv === 'production' ? 'oidc' : 'static')) as 'static' | 'oidc';
  const apiToken = env.EISENHOWER_API_TOKEN ?? (nodeEnv === 'production' ? '' : 'test-api-token');
  const oidcIssuer = env.OIDC_ISSUER ?? null;
  const oidcAudience = env.OIDC_AUDIENCE ?? null;
  const oidcJwksUrl = env.OIDC_JWKS_URL ?? null;
  const corsAllowOrigins = (env.CORS_ALLOW_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!['static', 'oidc'].includes(authMode)) {
    throw new Error('AUTH_MODE must be static or oidc.');
  }
  if (authMode === 'oidc' && !(oidcIssuer && oidcAudience && oidcJwksUrl)) {
    throw new Error('OIDC_ISSUER, OIDC_AUDIENCE and OIDC_JWKS_URL are required for OIDC auth.');
  }
  if (authMode === 'static' && nodeEnv === 'production' && apiToken.length < 32) {
    throw new Error('EISENHOWER_API_TOKEN must be at least 32 characters in production.');
  }
  if (nodeEnv === 'production' && corsAllowOrigins.length === 0) {
    throw new Error('CORS_ALLOW_ORIGINS is required in production.');
  }

  return {
    port: Number(env.PORT ?? DEFAULT_PORT),
    mongodbUri: env.MONGODB_URI ?? DEFAULT_MONGO_URI,
    aiServiceUrl: env.AI_SERVICE_URL ?? DEFAULT_AI_URL,
    nodeEnv,
    authMode,
    apiToken,
    oidcIssuer,
    oidcAudience,
    oidcJwksUrl,
    corsAllowOrigins,
  };
}
