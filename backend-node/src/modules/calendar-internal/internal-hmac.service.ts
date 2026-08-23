import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_CLOCK_SKEW_SECONDS = 300;

export type InternalHmacFailure = 'timestamp' | 'request-id' | 'signature';

export class InternalHmacService {
  constructor(private readonly key: string) {
    if (Buffer.byteLength(key) < 32) {
      throw new Error('CALENDAR_INTERNAL_HMAC_KEY must contain at least 32 bytes.');
    }
  }

  verify(input: {
    timestamp: string;
    requestId: string;
    signature: string;
    method: string;
    path: string;
    rawBody: Buffer;
  }): InternalHmacFailure | null {
    const epoch = Number(input.timestamp);
    if (!Number.isInteger(epoch) || Math.abs(Date.now() / 1000 - epoch) > MAX_CLOCK_SKEW_SECONDS) {
      return 'timestamp';
    }
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.requestId)) return 'request-id';
    const expected = createHmac('sha256', this.key)
      .update(`v1\n${input.timestamp}\n${input.requestId}\n${input.method}\n${input.path}\n${input.rawBody.toString('utf8')}`)
      .digest('hex');
    if (!/^[a-f0-9]{64}$/.test(input.signature)) return 'signature';
    const actualBuffer = Buffer.from(input.signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
      ? null
      : 'signature';
  }
}
