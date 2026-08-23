import { createOidcTokenVerifier } from '../src/auth';

describe('OIDC bearer verification', () => {
  it('verifies signature, issuer, audience and derives tenant scope from claims', async () => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const verify = createOidcTokenVerifier(
      {
        issuer: 'https://identity.example.com',
        audience: 'eisenhower-api',
        jwksUrl: 'https://identity.example.com/.well-known/jwks.json',
      },
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256' }] })
    );
    const token = await new SignJWT({
      tenant_id: 'tenant-a',
      roles: ['user'],
      project_ids: ['project-a'],
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer('https://identity.example.com')
      .setAudience('eisenhower-api')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verify(token)).resolves.toEqual({
      tenantId: 'tenant-a',
      userId: 'user-1',
      roles: ['user'],
      projectIds: ['project-a'],
    });
  });

  it('rejects a correctly signed token without a tenant claim', async () => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const verify = createOidcTokenVerifier(
      {
        issuer: 'https://identity.example.com',
        audience: 'eisenhower-api',
        jwksUrl: 'https://identity.example.com/.well-known/jwks.json',
      },
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256' }] })
    );
    const token = await new SignJWT({ roles: ['user'] })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer('https://identity.example.com')
      .setAudience('eisenhower-api')
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verify(token)).rejects.toThrow('Required OIDC claims are missing');
  });

  it('rejects a public JWKS endpoint on another origin', () => {
    expect(() => createOidcTokenVerifier({
      issuer: 'https://identity.example.com',
      audience: 'eisenhower-api',
      jwksUrl: 'https://attacker.example.net/jwks.json',
    })).toThrow('OIDC_JWKS_URL must use the issuer origin');
  });

  it('rejects non-HTTPS issuer and JWKS endpoints', () => {
    expect(() => createOidcTokenVerifier({
      issuer: 'http://identity.example.com',
      audience: 'eisenhower-api',
      jwksUrl: 'http://identity.example.com/jwks.json',
    })).toThrow('OIDC issuer and JWKS endpoint must use HTTPS');
  });

  it('maps missing optional array claims to empty scopes', async () => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const verify = createOidcTokenVerifier(
      {
        issuer: 'https://identity.example.com',
        audience: 'eisenhower-api',
        jwksUrl: 'https://identity.example.com/.well-known/jwks.json',
      },
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256' }] })
    );
    const token = await new SignJWT({ tenant_id: 'tenant-a', roles: 'admin', project_ids: [1] })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer('https://identity.example.com')
      .setAudience('eisenhower-api')
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verify(token)).resolves.toMatchObject({ roles: [], projectIds: [] });
  });

  it.each([
    { claims: { scope: 'tasks:read  calendar:write' }, scopes: ['tasks:read', 'calendar:write'] },
    { claims: { scp: ['tasks:read'] }, scopes: ['tasks:read'] },
  ])('maps supported OIDC scope claim shape %#', async ({ claims, scopes }) => {
    const { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } = await import('jose');
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const verify = createOidcTokenVerifier(
      {
        issuer: 'https://identity.example.com', audience: 'eisenhower-api',
        jwksUrl: 'https://identity.example.com/.well-known/jwks.json',
      },
      createLocalJWKSet({ keys: [{ ...jwk, kid: 'key-1', alg: 'RS256' }] })
    );
    const token = await new SignJWT({ tenant_id: 'tenant-a', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer('https://identity.example.com').setAudience('eisenhower-api')
      .setSubject('user-1').setExpirationTime('5m').sign(privateKey);

    await expect(verify(token)).resolves.toMatchObject({ scopes });
  });

});
