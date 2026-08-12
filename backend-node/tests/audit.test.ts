import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DurableFileAuditSink } from '../src/audit';

describe('durable Node audit ledger', () => {
  const key = 'node-audit-key-with-at-least-32-bytes';

  function paths() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'eisenhower-node-audit-'));
    const auditPath = path.join(directory, 'audit.ndjson');
    return { auditPath, headPath: `${auditPath}.head` };
  }

  it('persists only pseudonymous closed metadata and detects tail deletion', () => {
    const { auditPath } = paths();
    const sink = new DurableFileAuditSink(auditPath, key);
    sink.record({
      service: 'backend-node', releaseSha: 'a'.repeat(40), requestId: 'request-1',
      action: 'auth_rejection', outcome: 'rejected', tenantId: 'private-tenant',
      actorId: 'private-user', resourceId: '/tasks',
    });
    sink.record({
      service: 'backend-node', releaseSha: 'a'.repeat(40), requestId: 'request-2',
      action: 'acl_rejection', outcome: 'rejected', tenantId: 'private-tenant',
      actorId: 'private-user', resourceId: '/tasks',
    });

    const persisted = fs.readFileSync(auditPath, 'utf8');
    expect(persisted).not.toContain('private-tenant');
    expect(persisted).not.toContain('private-user');
    expect(persisted).toContain('auth_rejection');
    const lines = persisted.trimEnd().split('\n');
    fs.writeFileSync(auditPath, `${lines[0]}\n`, { mode: 0o600 });

    expect(() => new DurableFileAuditSink(
      auditPath, key
    )).toThrow('audit head does not match');
  });

  it('rejects weak keys, malformed identifiers, and an orphaned nonempty ledger', () => {
    const first = paths();
    expect(() => new DurableFileAuditSink(first.auditPath, 'short')).toThrow('at least 32 bytes');
    const sink = new DurableFileAuditSink(first.auditPath, key);
    const base = {
      service: 'backend-node' as const, releaseSha: 'a'.repeat(40), requestId: 'request-1',
      action: 'security_anomaly' as const, outcome: 'error' as const,
      tenantId: 'tenant', actorId: 'actor',
    };
    expect(() => sink.record({ ...base, releaseSha: 'bad' })).toThrow('release SHA');
    expect(() => sink.record({ ...base, requestId: 'bad request' })).toThrow('request ID');
    sink.record(base);
    expect(fs.readFileSync(first.auditPath, 'utf8')).not.toContain('resourcePseudonym');

    const second = paths();
    fs.writeFileSync(second.auditPath, '{}\n', { mode: 0o600 });
    expect(() => new DurableFileAuditSink(second.auditPath, key)).toThrow('audit head is missing');
  });

  it.each([
    ['predecessor', (record: Record<string, unknown>) => { record.previousHash = 'f'.repeat(64); }, 'sequence or predecessor'],
    ['payload', (record: Record<string, unknown>) => { record.action = 'acl_rejection'; }, 'chain integrity'],
  ])('detects changed %s metadata', (_label, mutate, message) => {
    const { auditPath } = paths();
    const sink = new DurableFileAuditSink(auditPath, key);
    sink.record({
      service: 'backend-node', releaseSha: 'a'.repeat(40), requestId: 'request-1',
      action: 'auth_rejection', outcome: 'rejected', tenantId: 'tenant', actorId: 'actor',
    });
    const record = JSON.parse(fs.readFileSync(auditPath, 'utf8')) as Record<string, unknown>;
    mutate(record);
    fs.writeFileSync(auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    expect(() => new DurableFileAuditSink(auditPath, key)).toThrow(message);
  });

  it('detects a modified authenticated head', () => {
    const { auditPath, headPath } = paths();
    new DurableFileAuditSink(auditPath, key);
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8')) as Record<string, unknown>;
    head.hmac = '0'.repeat(64);
    fs.writeFileSync(headPath, `${JSON.stringify(head)}\n`, { mode: 0o600 });
    expect(() => new DurableFileAuditSink(auditPath, key)).toThrow('head integrity');
  });
});
