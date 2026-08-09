let apiToken = null;
let adminToken = null;
const listeners = new Set();

export function getApiToken() {
  return apiToken;
}

export function getAdminToken() {
  return adminToken;
}

export function setApiToken(token) {
  apiToken = String(token || '').trim() || null;
  listeners.forEach((listener) => listener());
}

export function setAdminToken(token) {
  adminToken = String(token || '').trim() || null;
  listeners.forEach((listener) => listener());
}

export function setCredentials(accessToken, aiAdminToken) {
  apiToken = String(accessToken || '').trim() || null;
  adminToken = String(aiAdminToken || '').trim() || null;
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

export function subscribeToApiToken(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
