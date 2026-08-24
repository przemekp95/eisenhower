import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import mongoose from 'mongoose';
import { CalendarInternalRequestReceiptModel } from '../../models/calendar';

const MAX_CLOCK_SKEW_SECONDS = 300;
const INTERNAL_REQUEST_RECEIPT_TTL_MS = 24 * 60 * 60_000;

export const INTERNAL_HMAC_CONTEXT = Symbol('INTERNAL_HMAC_CONTEXT');

export interface InternalHmacRequestContext {
  requestId: string;
  fingerprint: string;
  service: InternalHmacService;
}

export interface InternalHmacRequest {
  [INTERNAL_HMAC_CONTEXT]?: InternalHmacRequestContext;
}

export class InternalHmacReplay {
  constructor(readonly statusCode: number, readonly responseBody?: unknown) {}
}

export type InternalHmacAuthorization =
  | { kind: 'failure'; failure: InternalHmacFailure }
  | { kind: 'accepted'; context: InternalHmacRequestContext }
  | { kind: 'replay'; replay: InternalHmacReplay };

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

  async authorize(input: {
    timestamp: string;
    requestId: string;
    signature: string;
    method: string;
    path: string;
    rawBody: Buffer;
  }): Promise<InternalHmacAuthorization> {
    const failure = this.verify(input);
    if (failure) return { kind: 'failure', failure };
    const fingerprint = createHash('sha256')
      .update(`${input.method}\n${input.path}\n${input.rawBody.toString('utf8')}`)
      .digest('hex');
    try {
      await CalendarInternalRequestReceiptModel.create({
        requestId: input.requestId,
        fingerprint,
        status: 'pending',
        expiresAt: new Date(Date.now() + INTERNAL_REQUEST_RECEIPT_TTL_MS),
      });
      return {
        kind: 'accepted',
        context: { requestId: input.requestId, fingerprint, service: this },
      };
    } catch (error) {
      if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const receipt = await CalendarInternalRequestReceiptModel.findOne({ requestId: input.requestId }).lean();
        if (!receipt || receipt.fingerprint !== fingerprint) {
          return { kind: 'replay', replay: new InternalHmacReplay(409, { error: 'calendar_request_id_reused' }) };
        }
        if (receipt.status === 'completed' && receipt.statusCode) {
          return { kind: 'replay', replay: new InternalHmacReplay(receipt.statusCode, receipt.responseBody) };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return { kind: 'replay', replay: new InternalHmacReplay(409, { error: 'calendar_request_in_progress' }) };
    }
  }

  complete(context: InternalHmacRequestContext | undefined, statusCode: number, responseBody?: unknown) {
    if (!context) return Promise.resolve();
    return CalendarInternalRequestReceiptModel.updateOne(
      { requestId: context.requestId, fingerprint: context.fingerprint, status: 'pending' },
      { $set: { status: 'completed', statusCode, responseBody } },
    ).then(() => undefined);
  }
}
