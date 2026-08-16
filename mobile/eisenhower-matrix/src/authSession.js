let apiToken = null;
const listeners = new Set();

export function getApiToken() {
  return apiToken;
}

export const getAccessToken = getApiToken;

export function setApiToken(token) {
  apiToken = String(token || '').trim() || null;
  listeners.forEach((listener) => listener());
}

export const setAccessToken = setApiToken;

export function clearApiToken() {
  apiToken = null;
  listeners.forEach((listener) => listener());
}

export const clearTokens = clearApiToken;

export function subscribeToApiToken(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
