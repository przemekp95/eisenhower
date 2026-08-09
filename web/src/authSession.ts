let apiToken: string | null = null;
let adminToken: string | null = null;
const listeners = new Set<() => void>();

export function getApiToken() {
  return apiToken;
}

export function getAdminToken() {
  return adminToken;
}

export function setApiToken(token: string) {
  apiToken = token.trim() || null;
  listeners.forEach((listener) => listener());
}

export function setAdminToken(token: string) {
  adminToken = token.trim() || null;
  listeners.forEach((listener) => listener());
}

export function setCredentials(accessToken: string, aiAdminToken: string) {
  apiToken = accessToken.trim() || null;
  adminToken = aiAdminToken.trim() || null;
  listeners.forEach((listener) => listener());
}

export function clearApiToken() {
  apiToken = null;
  adminToken = null;
  listeners.forEach((listener) => listener());
}

export function clearAdminToken() {
  adminToken = null;
  listeners.forEach((listener) => listener());
}

export function subscribeToApiToken(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
