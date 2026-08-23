import { Injectable } from '@nestjs/common';
import type { CreateAppOptions } from '../../app-options';
import {
  authenticateOidcBearer, authenticateStaticBearer, createOidcTokenVerifier,
} from '../../auth';
import type { AuthPrincipal, OidcTokenVerifier } from '../../auth';
import type { AppConfig } from '../../config';
import type { RequestContext } from '../../platform/http/request-context';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

@Injectable()
export class SecurityService {
  private readonly oidcVerifier: OidcTokenVerifier | null;

  constructor(
    private readonly config: AppConfig,
    options: CreateAppOptions,
  ) {
    this.oidcVerifier = config.authMode === 'oidc'
      ? options.oidcTokenVerifier ?? createOidcTokenVerifier({
          issuer: config.oidcIssuer!, audience: config.oidcAudience!, jwksUrl: config.oidcJwksUrl!,
        })
      : null;
  }

  async authenticate(authorization: string | undefined): Promise<AuthPrincipal> {
    if (this.oidcVerifier) return authenticateOidcBearer(authorization, this.oidcVerifier);
    return authenticateStaticBearer(authorization, this.config.apiToken);
  }

  isTrustedOrigin(context: RequestContext) {
    return !context.origin
      || SAFE_METHODS.has(context.method)
      || this.config.corsAllowOrigins.includes(context.origin);
  }

  hasScopes(principal: AuthPrincipal, required: string[]) {
    return required.every((scope) => principal.scopes?.includes(scope));
  }
}
