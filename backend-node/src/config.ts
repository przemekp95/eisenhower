export interface AppConfig {
  port: number;
  mongodbUri: string;
  aiServiceUrl: string;
  nodeEnv: string;
  jwtSecret: string | null;
}

const DEFAULT_MONGO_URI = 'mongodb://localhost:27017/eisenhower';
const DEFAULT_AI_URL = 'http://localhost:8000';
const DEFAULT_PORT = 3001;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const jwtSecret = env.JWT_SECRET ?? null;

  if (nodeEnv === 'production' && !jwtSecret) {
    throw new Error('JWT_SECRET must be set in production.');
  }

  return {
    port: Number(env.PORT ?? DEFAULT_PORT),
    mongodbUri: env.MONGODB_URI ?? DEFAULT_MONGO_URI,
    aiServiceUrl: env.AI_SERVICE_URL ?? DEFAULT_AI_URL,
    nodeEnv,
    jwtSecret,
  };
}
