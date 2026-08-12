import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, JWTVerifyGetKey, JWTPayload } from 'jose';
import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface AuthPrincipal {
  tenantId: string;
  userId: string;
  roles: string[];
  projectIds: string[];
  scopes?: string[];
}

export type SecurityRejectionHandler = (
  request: Request,
  action: 'auth_rejection' | 'acl_rejection',
) => void;

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPrincipal;
      requestId: string;
      rawBody?: Buffer;
    }
  }
}

function tokensMatch(actual: string, expected: string) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function auditOrFail(
  request: Request,
  response: Response,
  action: 'auth_rejection' | 'acl_rejection',
  onReject?: SecurityRejectionHandler,
): boolean {
  try {
    onReject?.(request, action);
    return true;
  } catch {
    console.error('backend-node required security audit write failed');
    response.status(503).json({ error: 'Security audit is unavailable' });
    return false;
  }
}

function readBearer(
  request: Request,
  response: Response,
  onReject?: SecurityRejectionHandler,
): string | null {
  const authorization = request.get('authorization');
  const match = authorization ? /^Bearer[ \t]+(.+)$/i.exec(authorization) : null;
  if (!match) {
    if (!auditOrFail(request, response, 'auth_rejection', onReject)) return null;
    response.set('WWW-Authenticate', 'Bearer');
    response.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return match[1];
}

function rejectInvalidBearer(
  request: Request,
  response: Response,
  onReject?: SecurityRejectionHandler,
) {
  if (!auditOrFail(request, response, 'auth_rejection', onReject)) return;
  response.set('WWW-Authenticate', 'Bearer error="invalid_token"');
  response.status(401).json({ error: 'Invalid bearer token' });
}

export function requireBearerToken(expectedToken: string, onReject?: SecurityRejectionHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    const token = readBearer(request, response, onReject);
    if (token === null) return;
    if (!tokensMatch(token, expectedToken)) {
      rejectInvalidBearer(request, response, onReject);
      return;
    }
    request.auth = {
      tenantId: 'local', userId: 'local-user', roles: ['user'], projectIds: [],
      scopes: ['tasks:read', 'tasks:write', 'calendar:read', 'calendar:write'],
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

export function requireScope(scope: string, onReject?: SecurityRejectionHandler) {
  return (request: Request, response: Response, next: NextFunction) => {
    if (request.auth?.scopes?.includes(scope)) return next();
    if (auditOrFail(request, response, 'acl_rejection', onReject)) {
      response.status(403).json({ error: 'Required scope is missing', code: 'insufficient_scope' });
    }
  };
}

export function requireOidcToken(
  verifier: (token: string) => Promise<AuthPrincipal>,
  onReject?: SecurityRejectionHandler,
) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const token = readBearer(request, response, onReject);
    if (token === null) return;
    try {
      request.auth = await verifier(token);
      next();
    } catch {
      rejectInvalidBearer(request, response, onReject);
    }
  };
}

export function requireTrustedBrowserOrigin(
  allowedOrigins: string[],
  onReject?: SecurityRejectionHandler,
) {
  const allowed = new Set(allowedOrigins);
  return (request: Request, response: Response, next: NextFunction) => {
    const origin = request.get('origin');
    if (!origin || SAFE_METHODS.has(request.method) || allowed.has(origin)) {
      next();
      return;
    }
    if (auditOrFail(request, response, 'acl_rejection', onReject)) {
      response.status(403).json({ error: 'Untrusted browser origin' });
    }
  };
}
