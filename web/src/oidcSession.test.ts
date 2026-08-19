import {
  beginOidcLogin,
  buildAccountManagementUrl,
  completeOidcLogin,
  resetOidcLoginAttempt,
} from './oidcSession';
import { clearTokens, getApiToken } from './authSession';
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

describe('OIDC Authorization Code with PKCE', () => {
  beforeAll(() => {
    Object.defineProperty(global, 'crypto', { configurable: true, value: webcrypto });
    Object.defineProperty(global, 'TextEncoder', { configurable: true, value: TextEncoder });
  });

  afterEach(() => {
    resetOidcLoginAttempt();
    clearTokens();
    sessionStorage.clear();
    jest.restoreAllMocks();
    delete (global as { fetch?: unknown }).fetch;
  });

  it('creates a state-bound S256 authorization request without storing a token', async () => {
    const assign = jest.fn();
    await beginOidcLogin(
      {
        issuer: 'https://identity.example/identity/realms/eisenhower',
        clientId: 'eisenhower-web',
        redirectUri: 'https://app.example/',
        scopes: 'openid profile tasks:read',
      },
      assign
    );

    const target = new URL(assign.mock.calls[0][0]);
    expect(target.pathname).toContain('/protocol/openid-connect/auth');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('state')).toBeTruthy();
    expect(sessionStorage.getItem('eisenhower.oidc.verifier')).toBeTruthy();
    expect(getApiToken()).toBeNull();
  });

  it('shares one in-flight authorization attempt before asynchronous PKCE work finishes', async () => {
    const assign = jest.fn();
    const config = {
      issuer: 'https://identity.example/identity/realms/eisenhower',
      clientId: 'eisenhower-web',
      redirectUri: 'https://app.example/',
      scopes: 'openid',
    };

    const first = beginOidcLogin(config, assign);
    const second = beginOidcLogin(config, assign);

    expect(second).toBe(first);
    await expect(first).resolves.toBe('started');
    expect(assign).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem('eisenhower.oidc.attempt')).toBe('starting');
  });

  it('treats a marker from an earlier document as recoverable instead of redirecting again', async () => {
    sessionStorage.setItem('eisenhower.oidc.attempt', 'starting');
    const assign = jest.fn();

    await expect(
      beginOidcLogin(
        {
          issuer: 'https://identity.example/identity/realms/eisenhower',
          clientId: 'eisenhower-web',
          redirectUri: 'https://app.example/',
          scopes: 'openid',
        },
        assign
      )
    ).resolves.toBe('already-started');
    expect(assign).not.toHaveBeenCalled();
  });

  it('allows a deliberate retry after resetting the authorization attempt', async () => {
    sessionStorage.setItem('eisenhower.oidc.attempt', 'starting');
    resetOidcLoginAttempt();
    const assign = jest.fn();

    await expect(
      beginOidcLogin(
        {
          issuer: 'https://identity.example/identity/realms/eisenhower',
          clientId: 'eisenhower-web',
          redirectUri: 'https://app.example/',
          scopes: 'openid',
        },
        assign
      )
    ).resolves.toBe('started');
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('clears the attempt marker when PKCE setup fails so a retry remains possible', async () => {
    const digest = jest.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce(new Error('crypto'));

    await expect(
      beginOidcLogin(
        {
          issuer: 'https://identity.example/identity/realms/eisenhower',
          clientId: 'eisenhower-web',
          redirectUri: 'https://app.example/',
          scopes: 'openid',
        },
        jest.fn()
      )
    ).rejects.toThrow('crypto');

    expect(sessionStorage.getItem('eisenhower.oidc.attempt')).toBeNull();
    digest.mockRestore();
  });

  it('builds only an HTTP(S) Keycloak account-management URL from the configured issuer', () => {
    expect(buildAccountManagementUrl('https://identity.example/identity/realms/eisenhower/')).toBe(
      'https://identity.example/identity/realms/eisenhower/account'
    );
    expect(buildAccountManagementUrl('javascript:alert(1)')).toBeNull();
    expect(buildAccountManagementUrl(undefined)).toBeNull();
    expect(buildAccountManagementUrl('not a URL')).toBeNull();
  });

  it('rejects a mismatched callback state before contacting the token endpoint', async () => {
    sessionStorage.setItem('eisenhower.oidc.state', 'expected');
    sessionStorage.setItem('eisenhower.oidc.verifier', 'verifier');
    const fetchMock = jest.fn();
    global.fetch = fetchMock;

    await expect(
      completeOidcLogin(new URL('https://app.example/?code=code&state=wrong'), {
        issuer: 'https://identity.example/identity/realms/eisenhower',
        clientId: 'eisenhower-web',
        redirectUri: 'https://app.example/',
        scopes: 'openid',
      })
    ).rejects.toThrow('state');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('eisenhower.oidc.state')).toBeNull();
    expect(sessionStorage.getItem('eisenhower.oidc.verifier')).toBeNull();
  });

  it('ignores a URL that is not an authorization callback', async () => {
    await expect(
      completeOidcLogin(new URL('https://app.example/'), {
        issuer: 'https://identity.example/identity/realms/eisenhower',
        clientId: 'eisenhower-web',
        redirectUri: 'https://app.example/',
        scopes: 'openid',
      })
    ).resolves.toBe(false);
  });

  it('rejects failed and malformed token responses without retaining one-shot state', async () => {
    const config = {
      issuer: 'https://identity.example/identity/realms/eisenhower',
      clientId: 'eisenhower-web',
      redirectUri: 'https://app.example/',
      scopes: 'openid',
    };
    for (const response of [
      { ok: false, json: async () => ({}) },
      { ok: true, json: async () => ({ access_token: '' }) },
    ]) {
      sessionStorage.setItem('eisenhower.oidc.state', 'expected');
      sessionStorage.setItem('eisenhower.oidc.verifier', 'verifier');
      global.fetch = jest.fn().mockResolvedValue(response);
      await expect(
        completeOidcLogin(new URL('https://app.example/?code=code&state=expected'), config)
      ).rejects.toThrow(/token/);
      expect(sessionStorage.getItem('eisenhower.oidc.state')).toBeNull();
      expect(sessionStorage.getItem('eisenhower.oidc.verifier')).toBeNull();
    }
  });

  it('exchanges a matching callback once and keeps the access token only in memory', async () => {
    sessionStorage.setItem('eisenhower.oidc.state', 'expected');
    sessionStorage.setItem('eisenhower.oidc.verifier', 'verifier');
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'oidc-access-token' }),
    });
    global.fetch = fetchMock;
    const replaceState = jest.spyOn(window.history, 'replaceState');

    await expect(
      completeOidcLogin(new URL('http://localhost/?code=code&state=expected'), {
        issuer: 'https://identity.example/identity/realms/eisenhower',
        clientId: 'eisenhower-web',
        redirectUri: 'http://localhost/',
        scopes: 'openid',
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://identity.example/identity/realms/eisenhower/protocol/openid-connect/token',
      expect.objectContaining({ method: 'POST' })
    );
    expect(getApiToken()).toBe('oidc-access-token');
    expect(sessionStorage.getItem('eisenhower.oidc.verifier')).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(replaceState).toHaveBeenCalledWith({}, document.title, 'http://localhost/');
  });
});
