import { createHash, timingSafeEqual } from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function tokensMatch(actual: string, expected: string) {
  const actualDigest = createHash('sha256').update(actual).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();

  return timingSafeEqual(actualDigest, expectedDigest);
}

export function requireBearerToken(expectedToken: string) {
  return (request: Request, response: Response, next: NextFunction) => {
    const authorization = request.get('authorization');

    if (!authorization?.startsWith('Bearer ')) {
      response.set('WWW-Authenticate', 'Bearer');
      response.status(401).json({ error: 'Authentication required' });
      return;
    }

    const suppliedToken = authorization.slice('Bearer '.length);
    if (!tokensMatch(suppliedToken, expectedToken)) {
      response.status(403).json({ error: 'Access denied' });
      return;
    }

    next();
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
