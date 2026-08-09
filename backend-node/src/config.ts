export interface AppConfig {
  port: number;
  mongodbUri: string;
  aiServiceUrl: string;
  nodeEnv: string;
  apiToken: string;
  corsAllowOrigins: string[];
}

const DEFAULT_MONGO_URI = 'mongodb://localhost:27017/eisenhower';
const DEFAULT_AI_URL = 'http://localhost:8000';
const DEFAULT_PORT = 3001;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const apiToken = env.EISENHOWER_API_TOKEN ?? (nodeEnv === 'test' ? 'test-api-token' : '');
  const corsAllowOrigins = (env.CORS_ALLOW_ORIGINS ??
    'http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (nodeEnv === 'production' && !apiToken) {
    throw new Error('EISENHOWER_API_TOKEN must be set in production.');
  }

  if (!apiToken) {
    throw new Error('EISENHOWER_API_TOKEN must be set outside tests.');
  }

  if (nodeEnv === 'production' && apiToken.length < 32) {
    throw new Error('EISENHOWER_API_TOKEN must be at least 32 characters in production.');
  }

  if (nodeEnv === 'production' && corsAllowOrigins.length === 0) {
    throw new Error(
      'CORS_ALLOW_ORIGINS must list at least one trusted frontend origin in production.'
    );
  }

  return {
    port: Number(env.PORT ?? DEFAULT_PORT),
    mongodbUri: env.MONGODB_URI ?? DEFAULT_MONGO_URI,
    aiServiceUrl: env.AI_SERVICE_URL ?? DEFAULT_AI_URL,
    nodeEnv,
    apiToken,
    corsAllowOrigins,
  };
}
