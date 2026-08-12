import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey, JWTPayload } from 'jose';
import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthPrincipal {
  tenantId: string;
  userId: string;
  roles: string[];
  projectIds: string[];
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPrincipal;
    }
  }
}

function tokensMatch(actual: string, expected: string) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function readBearer(request: Request, response: Response): string | null {
  const authorization = request.get('authorization');
  const match = authorization ? /^Bearer[ \t]+(.+)$/i.exec(authorization) : null;
  if (!match) {
    response.set('WWW-Authenticate', 'Bearer');
    response.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return match[1];
}

function rejectInvalidBearer(response: Response) {
  response.set('WWW-Authenticate', 'Bearer error="invalid_token"');
  response.status(401).json({ error: 'Invalid bearer token' });
}

export function requireBearerToken(expectedToken: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = readBearer(request, response);
    if (token === null) return;
    if (!tokensMatch(token, expectedToken)) {
      rejectInvalidBearer(response);
      return;
    }
    request.auth = {
      tenantId: 'local', userId: 'local-user', roles: ['user'], projectIds: [],
    };
    next();
  };
}

export interface OidcVerifierConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
}

export function createOidcTokenVerifier(
  config: OidcVerifierConfig,
  keyResolver?: JWTVerifyGetKey,
): (token: string) => Promise<AuthPrincipal> {
  const issuer = new URL(config.issuer);
  const jwks = new URL(config.jwksUrl);
  if (issuer.protocol !== 'https:' || jwks.protocol !== 'https:') {
    throw new Error('OIDC issuer and JWKS endpoint must use HTTPS');
  }
  if (issuer.origin !== jwks.origin) {
    throw new Error('OIDC_JWKS_URL must use the issuer origin');
  }
  const resolveKey = keyResolver ?? createRemoteJWKSet(jwks, {
    timeoutDuration: 3000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  return async (token: string) => {
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
  return {
    tenantId: payload.tenant_id,
    userId: payload.sub,
    roles: stringArray(payload.roles),
    projectIds: stringArray(payload.project_ids),
  };
}

export function requireOidcToken(verifier: (token: string) => Promise<AuthPrincipal>) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const token = readBearer(request, response);
    if (token === null) return;
    try {
      request.auth = await verifier(token);
      next();
    } catch {
      rejectInvalidBearer(response);
    }
  };
}

export function requireTrustedBrowserOrigin(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = request.get('origin');
    if (!origin || SAFE_METHODS.has(request.method) || allowed.has(origin)) {
      next();
      return;
    }
    response.status(403).json({ error: 'Untrusted browser origin' });
  };
}
