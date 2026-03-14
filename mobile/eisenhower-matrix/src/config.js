const normalizeOptionalUrl = (value, variableName) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  if (!trimmedValue) {
    throw new Error(`${variableName} must not be empty when provided.`);
  }

  return trimmedValue.replace(/\/+$/, '');
};

const normalizeOptionalOrigin = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue.replace(/\/+$/, '') : null;
};

const isDevelopmentBuild =
  typeof __DEV__ === 'boolean' ? __DEV__ : process.env.NODE_ENV !== 'production';

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

const sharedOrigin = normalizeOptionalOrigin(process.env.EXPO_PUBLIC_APP_ORIGIN_URL);
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
