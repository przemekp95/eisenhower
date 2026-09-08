import os from 'node:os';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import { DurableFileAuditSink, StructuredStdoutAuditSink } from '../../audit';
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
    const auditSinkMode = process.env.AUDIT_SINK ?? 'file';
    if (config.nodeEnv === 'production' && (
      !['file', 'stdout'].includes(auditSinkMode)
      || (auditSinkMode === 'file' && !process.env.AUDIT_LOG_PATH)
      || !process.env.AUDIT_HMAC_KEY
      || Buffer.byteLength(process.env.AUDIT_HMAC_KEY) < 32
      || !process.env.RELEASE_SHA
      || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA)
    )) {
      throw new Error(
        'A durable AUDIT_SINK (and AUDIT_LOG_PATH for file mode), strong AUDIT_HMAC_KEY, and exact RELEASE_SHA are required in production.',
      );
    }
    const auditKey = process.env.AUDIT_HMAC_KEY ?? 'development-node-audit-key-change-me-now';
    this.sink = options.auditSink ?? (auditSinkMode === 'stdout'
      ? new StructuredStdoutAuditSink(auditKey)
      : new DurableFileAuditSink(
        process.env.AUDIT_LOG_PATH ?? path.join(
          os.tmpdir(), `eisenhower-node-audit-${process.pid}.ndjson`,
        ),
        auditKey,
      ));
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
