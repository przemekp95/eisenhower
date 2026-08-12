import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type AuditAction = 'auth_rejection' | 'acl_rejection' | 'security_anomaly';
export type AuditOutcome = 'rejected' | 'error';

export interface AuditEvent {
  service: 'backend-node';
  releaseSha: string;
  requestId: string;
  action: AuditAction;
  outcome: AuditOutcome;
  tenantId: string;
  actorId: string;
  resourceId?: string;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

interface StoredEvent {
  sequence: number;
  occurredAt: string;
  service: string;
  releaseSha: string;
  requestId: string;
  action: AuditAction;
  outcome: AuditOutcome;
  tenantPseudonym: string;
  actorPseudonym: string;
  resourcePseudonym?: string;
  previousHash: string;
  integrityHash: string;
}

const GENESIS_HASH = '0'.repeat(64);
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class DurableFileAuditSink implements AuditSink {
  private readonly headPath: string;

  constructor(private readonly auditPath: string, private readonly key: string) {
    if (Buffer.byteLength(key) < 32) throw new Error('audit key must contain at least 32 bytes');
    this.headPath = `${auditPath}.head`;
    fs.mkdirSync(path.dirname(auditPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(auditPath)) fs.writeFileSync(auditPath, '', { mode: 0o600, flag: 'wx' });
    fs.chmodSync(auditPath, 0o600);
    if (!fs.existsSync(this.headPath)) {
      if (fs.statSync(auditPath).size !== 0) throw new Error('audit head is missing');
      this.writeHead(0, GENESIS_HASH);
    }
    this.verify();
  }

  record(event: AuditEvent): void {
    if (!SHA_PATTERN.test(event.releaseSha)) throw new Error('release SHA is invalid');
    if (!REQUEST_PATTERN.test(event.requestId)) throw new Error('request ID is invalid');
    const current = this.verify();
    const withoutIntegrity = {
      sequence: current.sequence + 1,
      occurredAt: new Date().toISOString(),
      service: event.service,
      releaseSha: event.releaseSha,
      requestId: event.requestId,
      action: event.action,
      outcome: event.outcome,
      tenantPseudonym: this.pseudonym('tenant', event.tenantId),
      actorPseudonym: this.pseudonym('actor', event.actorId),
      ...(event.resourceId
        ? { resourcePseudonym: this.pseudonym('resource', event.resourceId) }
        : {}),
      previousHash: current.hash,
    };
    const stored: StoredEvent = {
      ...withoutIntegrity,
      integrityHash: this.mac('audit-chain-v1', JSON.stringify(withoutIntegrity)),
    };
    const descriptor = fs.openSync(this.auditPath, 'a', 0o600);
    try {
      fs.writeSync(descriptor, `${JSON.stringify(stored)}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    this.writeHead(stored.sequence, stored.integrityHash);
  }

  private verify(): { sequence: number; hash: string } {
    const content = fs.readFileSync(this.auditPath, 'utf8');
    const lines = content ? content.trimEnd().split('\n') : [];
    let sequence = 0;
    let previousHash = GENESIS_HASH;
    for (const line of lines) {
      const stored = JSON.parse(line) as StoredEvent;
      if (stored.sequence !== sequence + 1 || stored.previousHash !== previousHash) {
        throw new Error('audit chain sequence or predecessor is invalid');
      }
      const { integrityHash, ...payload } = stored;
      const expected = this.mac('audit-chain-v1', JSON.stringify(payload));
      if (integrityHash !== expected) throw new Error('audit chain integrity is invalid');
      sequence = stored.sequence;
      previousHash = stored.integrityHash;
    }
    const head = JSON.parse(fs.readFileSync(this.headPath, 'utf8')) as {
      sequence: number; hash: string; hmac: string;
    };
    const expectedHeadHmac = this.mac('audit-head-v1', `${head.sequence}:${head.hash}`);
    if (head.hmac !== expectedHeadHmac) throw new Error('audit head integrity is invalid');
    if (head.sequence !== sequence || head.hash !== previousHash) {
      throw new Error('audit head does not match the retained chain');
    }
    return { sequence, hash: previousHash };
  }

  private writeHead(sequence: number, hash: string): void {
    const head = { sequence, hash, hmac: this.mac('audit-head-v1', `${sequence}:${hash}`) };
    const temporary = `${this.headPath}.${process.pid}.${randomUUID()}`;
    fs.writeFileSync(temporary, `${JSON.stringify(head)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, this.headPath);
    fs.chmodSync(this.headPath, 0o600);
  }

  private pseudonym(kind: string, value: string): string {
    return this.mac('audit-pseudonym-v1', `${kind}\0${value}`);
  }

  private mac(domain: string, value: string): string {
    return createHmac('sha256', this.key).update(`${domain}\0${value}`).digest('hex');
  }
}
