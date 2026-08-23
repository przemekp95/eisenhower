import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyReply, FastifyRequest } from 'fastify';
import { BearerAuthenticationError } from '../../auth';
import { requestContextFor } from '../../platform/http/request-context';
import { AuditService, SecurityAuditUnavailableError } from './audit.service';
import {
  INTERNAL_ROUTE_METADATA, PUBLIC_ROUTE_METADATA, REQUIRED_SCOPES_METADATA,
} from './security.decorators';
import { SecurityService } from './security.service';

@Injectable()
export class SecurityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly security: SecurityService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(execution: ExecutionContext) {
    const request = execution.switchToHttp().getRequest<FastifyRequest>();
    const reply = execution.switchToHttp().getResponse<FastifyReply>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_METADATA, [
      execution.getHandler(), execution.getClass(),
    ]);
    const isInternal = this.reflector.getAllAndOverride<boolean>(INTERNAL_ROUTE_METADATA, [
      execution.getHandler(), execution.getClass(),
    ]);
    if (isPublic || isInternal || request.method === 'OPTIONS') return true;

    const context = requestContextFor(request);
    try {
      context.principal = await this.security.authenticate(request.headers.authorization);
    } catch (error) {
      if (!(error instanceof BearerAuthenticationError)) throw error;
      this.auditRejection(context, 'auth_rejection');
      if (error.failure === 'missing') {
        reply.header('WWW-Authenticate', 'Bearer');
        throw new HttpException({ error: 'Authentication required' }, HttpStatus.UNAUTHORIZED);
      }
      reply.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw new HttpException({ error: 'Invalid bearer token' }, HttpStatus.UNAUTHORIZED);
    }

    if (!this.security.isTrustedOrigin(context)) {
      this.auditRejection(context, 'acl_rejection');
      throw new HttpException({ error: 'Untrusted browser origin' }, HttpStatus.FORBIDDEN);
    }

    const scopes = this.reflector.getAllAndOverride<string[]>(REQUIRED_SCOPES_METADATA, [
      execution.getHandler(), execution.getClass(),
    ]) ?? [];
    if (!this.security.hasScopes(context.principal, scopes)) {
      this.auditRejection(context, 'acl_rejection');
      throw new HttpException(
        { error: 'Required scope is missing', code: 'insufficient_scope' },
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }

  private auditRejection(
    context: ReturnType<typeof requestContextFor>,
    action: 'auth_rejection' | 'acl_rejection',
  ) {
    try {
      this.audit.recordOrThrow(context, action);
    } catch (error) {
      if (error instanceof SecurityAuditUnavailableError) {
        throw new HttpException(
          { error: 'Security audit is unavailable' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      throw error;
    }
  }
}
