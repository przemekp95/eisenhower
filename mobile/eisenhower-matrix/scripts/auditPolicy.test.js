const { validateAudit } = require('./auditPolicy');

const allowedAudit = {
  metadata: { vulnerabilities: { critical: 0 } },
  vulnerabilities: {
    'image-size': {
      via: [
        { source: 1138808 },
        { source: 1138809 },
      ],
    },
    metro: { via: ['image-size'] },
  },
};

describe('mobile production audit policy', () => {
  it('accepts a clean audit', () => {
    expect(validateAudit({ metadata: { vulnerabilities: { critical: 0 } }, vulnerabilities: {} }, new Date('2026-08-09'))).toEqual([]);
  });

  it('accepts only the documented image-size advisory chain before expiry', () => {
    expect(validateAudit(allowedAudit, new Date('2026-08-09'))).toEqual([]);
  });

  it('rejects critical, unknown, or expired findings', () => {
    expect(validateAudit({ metadata: { vulnerabilities: { critical: 1 } }, vulnerabilities: {} }, new Date('2026-08-09'))).not.toEqual([]);
    expect(validateAudit({ ...allowedAudit, vulnerabilities: { other: { via: [{ source: 999 }] } } }, new Date('2026-08-09'))).not.toEqual([]);
    expect(validateAudit(allowedAudit, new Date('2026-11-01'))).not.toEqual([]);
  });
});
