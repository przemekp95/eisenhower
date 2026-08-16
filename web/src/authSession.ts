let apiToken: string | null = null;
let accessRejection: 'rejected' | null = null;
const listeners = new Set<() => void>();

export function getApiToken() {
  return apiToken;
}

export const getAccessToken = getApiToken;

export function getAccessRejection() {
  return accessRejection;
}

export function setApiToken(token: string) {
  apiToken = token.trim() || null;
  accessRejection = null;
  listeners.forEach((listener) => listener());
}

export const setAccessToken = setApiToken;

export function clearApiToken(reason?: 'rejected') {
  apiToken = null;
  accessRejection = reason ?? null;
  listeners.forEach((listener) => listener());
}

export const clearTokens = clearApiToken;

export function rejectApiToken() {
  clearApiToken('rejected');
}

export function subscribeToApiToken(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
