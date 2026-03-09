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

const sharedOrigin = normalizeOptionalOrigin(process.env.EXPO_PUBLIC_APP_ORIGIN_URL);
const explicitApiUrl = normalizeOptionalUrl(
  process.env.EXPO_PUBLIC_API_URL,
  'EXPO_PUBLIC_API_URL'
);
const explicitAiApiUrl = normalizeOptionalUrl(
  process.env.EXPO_PUBLIC_AI_API_URL,
  'EXPO_PUBLIC_AI_API_URL'
);
const fallbackApiUrl = sharedOrigin ? `${sharedOrigin}/api` : 'http://127.0.0.1:3001';
const fallbackAiApiUrl = sharedOrigin ? `${sharedOrigin}/ai` : 'http://127.0.0.1:8000';

export const mobileConfig = {
  appOrigin: sharedOrigin,
  apiUrl: explicitApiUrl ?? fallbackApiUrl,
  aiApiUrl: explicitAiApiUrl ?? fallbackAiApiUrl,
};
