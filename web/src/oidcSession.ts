import { setApiToken } from './authSession';

export type OidcRuntimeConfig = {
  issuer: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
};

const STATE_KEY = 'eisenhower.oidc.state';
const VERIFIER_KEY = 'eisenhower.oidc.verifier';

export function buildAccountManagementUrl(issuer: string | undefined) {
  if (!issuer) return null;
  try {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.search = '';
    url.hash = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/account`;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomValue(size: number) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function beginOidcLogin(
  config: OidcRuntimeConfig,
  /* istanbul ignore next -- jsdom cannot perform a real top-level navigation */
  navigate: (target: string) => void = (target) => window.location.assign(target)
) {
  const verifier = randomValue(48);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const state = randomValue(24);
  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);

  const authorizationUrl = new URL(
    `${config.issuer.replace(/\/+$/, '')}/protocol/openid-connect/auth`
  );
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: config.scopes,
    state,
    code_challenge: base64Url(new Uint8Array(digest)),
    code_challenge_method: 'S256',
  }).toString();
  navigate(authorizationUrl.toString());
}

export async function completeOidcLogin(url: URL, config: OidcRuntimeConfig) {
  const code = url.searchParams.get('code');
  if (!code) return false;

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!expectedState || url.searchParams.get('state') !== expectedState || !verifier) {
    throw new Error('OIDC callback state is invalid');
  }

  const response = await fetch(
    `${config.issuer.replace(/\/+$/, '')}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code,
        code_verifier: verifier,
      }),
    }
  );
  if (!response.ok) throw new Error('OIDC token exchange failed');
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error('OIDC token response is invalid');
  }

  setApiToken(body.access_token);
  window.history.replaceState({}, document.title, config.redirectUri);
  return true;
}
