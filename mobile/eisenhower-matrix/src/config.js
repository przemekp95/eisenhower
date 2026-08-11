const isDevelopmentBuild =
  typeof __DEV__ === 'boolean' ? __DEV__ : process.env.NODE_ENV !== 'production';

const LOOPBACK_OR_EMULATOR_HOSTS = new Set([
  'localhost',
  '::1',
  '10.0.2.2',
  '10.0.3.2',
]);

const normalizeOptionalUrl = (value, variableName, { originOnly = false } = {}) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error(`${variableName} must not be empty when provided.`);
  }

  let parsed;
  try {
    parsed = new URL(trimmedValue);
  } catch {
    throw new Error(`${variableName} must be an absolute HTTP(S) URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${variableName} must be an absolute HTTP(S) URL.`);
  }
  if (!isDevelopmentBuild && parsed.protocol !== 'https:') {
    throw new Error(`${variableName} must use HTTPS in production builds.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${variableName} must not include credentials.`);
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${variableName} must not include a query or fragment.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    !isDevelopmentBuild &&
    (LOOPBACK_OR_EMULATOR_HOSTS.has(hostname) || hostname.startsWith('127.'))
  ) {
    throw new Error(`${variableName} must not use a loopback or emulator host.`);
  }
  if (originOnly && parsed.pathname !== '/') {
    throw new Error(`${variableName} must be an origin without a path, query, or fragment.`);
  }

  return originOnly ? parsed.origin : parsed.toString().replace(/\/+$/, '');
};

const createDevelopmentLoopbackUrl = (port) => {
  const host = ['127', '0', '0', '1'].join('.');
  return `http://${host}:${port}`;
};

const resolveConfiguredUrl = ({ explicitUrl, sharedOriginValue, pathSuffix, envName, devPort }) => {
  if (explicitUrl) {
    return explicitUrl;
  }

  if (sharedOriginValue) {
    return `${sharedOriginValue}${pathSuffix}`;
  }

  if (isDevelopmentBuild) {
    return createDevelopmentLoopbackUrl(devPort);
  }

  throw new Error(`${envName} or EXPO_PUBLIC_APP_ORIGIN_URL is required in production builds.`);
};

const sharedOrigin = normalizeOptionalUrl(
  process.env.EXPO_PUBLIC_APP_ORIGIN_URL,
  'EXPO_PUBLIC_APP_ORIGIN_URL',
  { originOnly: true }
);
const explicitApiUrl = normalizeOptionalUrl(
  process.env.EXPO_PUBLIC_API_URL,
  'EXPO_PUBLIC_API_URL'
);
const explicitAiApiUrl = normalizeOptionalUrl(
  process.env.EXPO_PUBLIC_AI_API_URL,
  'EXPO_PUBLIC_AI_API_URL'
);

export const mobileConfig = {
  appOrigin: sharedOrigin,
  apiUrl: resolveConfiguredUrl({
    explicitUrl: explicitApiUrl,
    sharedOriginValue: sharedOrigin,
    pathSuffix: '/api',
    envName: 'EXPO_PUBLIC_API_URL',
    devPort: 3001,
  }),
  aiApiUrl: resolveConfiguredUrl({
    explicitUrl: explicitAiApiUrl,
    sharedOriginValue: sharedOrigin,
    pathSuffix: '/ai',
    envName: 'EXPO_PUBLIC_AI_API_URL',
    devPort: 8000,
  }),
};
