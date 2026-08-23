import { createHash, timingSafeEqual } from 'node:crypto';
import type { JWTVerifyGetKey, JWTPayload } from 'jose' with { 'resolution-mode': 'import' };

export interface AuthPrincipal {
  tenantId: string;
  userId: string;
  roles: string[];
  projectIds: string[];
  scopes?: string[];
}

export function tokensMatch(actual: string, expected: string) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

export type BearerAuthenticationFailure = 'missing' | 'invalid';

export class BearerAuthenticationError extends Error {
  constructor(readonly failure: BearerAuthenticationFailure) {
    super(failure === 'missing' ? 'Authentication required' : 'Invalid bearer token');
  }
}

export function readBearerAuthorization(authorization: string | undefined): string {
  const match = authorization ? /^Bearer[ \t]+(.+)$/i.exec(authorization) : null;
  if (!match) throw new BearerAuthenticationError('missing');
  return match[1];
}

export function authenticateStaticBearer(
  authorization: string | undefined,
  expectedToken: string,
): AuthPrincipal {
  const token = readBearerAuthorization(authorization);
  if (!tokensMatch(token, expectedToken)) throw new BearerAuthenticationError('invalid');
  return {
    tenantId: 'local', userId: 'local-user', roles: ['user'], projectIds: [],
    scopes: ['tasks:read', 'tasks:write', 'calendar:read', 'calendar:write'],
  };
}

export async function authenticateOidcBearer(
  authorization: string | undefined,
  verifier: OidcTokenVerifier,
): Promise<AuthPrincipal> {
  const token = readBearerAuthorization(authorization);
  try {
    return await verifier(token);
  } catch {
    throw new BearerAuthenticationError('invalid');
  }
}

export interface OidcVerifierConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export type OidcTokenVerifier = (token: string) => Promise<AuthPrincipal>;

export function createOidcTokenVerifier(
  config: OidcVerifierConfig,
  keyResolver?: JWTVerifyGetKey,
): OidcTokenVerifier {
  const issuer = new URL(config.issuer);
  const jwks = new URL(config.jwksUrl);
  if (issuer.protocol !== 'https:' || jwks.protocol !== 'https:') {
    throw new Error('OIDC issuer and JWKS endpoint must use HTTPS');
  }
  if (issuer.origin !== jwks.origin) {
    throw new Error('OIDC_JWKS_URL must use the issuer origin');
  }
  let resolveKey = keyResolver;
  return async (token: string) => {
    const { createRemoteJWKSet, jwtVerify } = await import('jose');
    resolveKey ??= createRemoteJWKSet(jwks, {
      timeoutDuration: 3000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    });
    const { payload } = await jwtVerify(token, resolveKey, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256', 'ES256'],
      clockTolerance: 5,
    });
    return principalFromClaims(payload);
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

function principalFromClaims(payload: JWTPayload): AuthPrincipal {
  if (!payload.sub || typeof payload.tenant_id !== 'string' || !payload.tenant_id) {
    throw new Error('Required OIDC claims are missing');
  }
  const scopes = typeof payload.scope === 'string'
    ? payload.scope.split(/\s+/).filter(Boolean)
    : stringArray(payload.scp);
  return {
    tenantId: payload.tenant_id,
    userId: payload.sub,
    roles: stringArray(payload.roles),
    projectIds: stringArray(payload.project_ids),
    ...(scopes.length ? { scopes } : {}),
  };
}
