import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { DurableFileAuditSink } from '../../audit';
import type { AuditSink } from '../../audit';
import type { CreateAppOptions } from '../../app-options';
import type { AppConfig } from '../../config';
import type { RequestContext } from '../../platform/http/request-context';

export class SecurityAuditUnavailableError extends Error {}

@Injectable()
export class AuditService {
  private readonly sink: AuditSink;
  private readonly releaseSha: string;

  constructor(options: CreateAppOptions, config: AppConfig) {
    if (config.nodeEnv === 'production' && (
      !process.env.AUDIT_LOG_PATH
      || !process.env.AUDIT_HMAC_KEY
      || Buffer.byteLength(process.env.AUDIT_HMAC_KEY) < 32
      || !process.env.RELEASE_SHA
      || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA)
    )) {
      throw new Error(
        'AUDIT_LOG_PATH, a strong AUDIT_HMAC_KEY, and exact RELEASE_SHA are required in production.',
      );
    }
    this.sink = options.auditSink ?? new DurableFileAuditSink(
      process.env.AUDIT_LOG_PATH ?? path.join(
        os.tmpdir(), `eisenhower-node-audit-${process.pid}.ndjson`,
      ),
      process.env.AUDIT_HMAC_KEY ?? 'development-node-audit-key-change-me-now',
    );
    this.releaseSha = process.env.RELEASE_SHA ?? '0'.repeat(40);
  }

  recordOrThrow(context: RequestContext, action: 'auth_rejection' | 'acl_rejection') {
    try {
      this.sink.record({
        service: 'backend-node',
        releaseSha: this.releaseSha,
        requestId: context.requestId,
        action,
        outcome: 'rejected',
        tenantId: context.principal?.tenantId ?? 'unknown',
        actorId: context.principal?.userId ?? 'anonymous',
        resourceId: context.path,
      });
    } catch {
      console.error('backend-node required security audit write failed');
      throw new SecurityAuditUnavailableError('Security audit is unavailable');
    }
  }
}
