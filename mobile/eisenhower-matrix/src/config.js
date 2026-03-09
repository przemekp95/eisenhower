const sharedOrigin = (process.env.EXPO_PUBLIC_APP_ORIGIN_URL || '').replace(/\/+$/, '');
const fallbackApiUrl = sharedOrigin ? `${sharedOrigin}/api` : 'http://127.0.0.1:3001';
const fallbackAiApiUrl = sharedOrigin ? `${sharedOrigin}/ai` : 'http://127.0.0.1:8000';

export const mobileConfig = {
  appOrigin: sharedOrigin || null,
  apiUrl: process.env.EXPO_PUBLIC_API_URL || fallbackApiUrl,
  aiApiUrl: process.env.EXPO_PUBLIC_AI_API_URL || fallbackAiApiUrl,
};
