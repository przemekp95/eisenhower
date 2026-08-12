let apiToken: string | null = null;
let adminToken: string | null = null;
let accessRejection: 'rejected' | null = null;
let adminRejection: 'rejected' | null = null;
const listeners = new Set<() => void>();

export function getApiToken() {
  return apiToken;
}

export const getAccessToken = getApiToken;

export function getAdminToken() {
  return adminToken;
}

export function getAccessRejection() {
  return accessRejection;
}

export function getAdminRejection() {
  return adminRejection;
}

export function setApiToken(token: string) {
  apiToken = token.trim() || null;
  accessRejection = null;
  listeners.forEach((listener) => listener());
}

export const setAccessToken = setApiToken;

export function setAdminToken(token: string) {
  adminToken = token.trim() || null;
  adminRejection = null;
  listeners.forEach((listener) => listener());
}

export function setCredentials(accessToken: string, aiAdminToken: string) {
  apiToken = accessToken.trim() || null;
  adminToken = aiAdminToken.trim() || null;
  accessRejection = null;
  adminRejection = null;
  listeners.forEach((listener) => listener());
}

export function clearApiToken(reason?: 'rejected') {
  apiToken = null;
  adminToken = null;
  accessRejection = reason ?? null;
  adminRejection = null;
  listeners.forEach((listener) => listener());
}

export const clearTokens = clearApiToken;

export function rejectApiToken() {
  clearApiToken('rejected');
}

export function clearAdminToken(reason?: 'rejected') {
  adminToken = null;
  adminRejection = reason ?? null;
  listeners.forEach((listener) => listener());
}

export function rejectAdminToken() {
  clearAdminToken('rejected');
}

export function subscribeToApiToken(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
