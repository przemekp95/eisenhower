import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  attachRequestContext, requestContextFor,
} from '../../src/platform/http/request-context';

describe('Fastify request context allocation', () => {
  it('keeps request timing in the existing context object', () => {
    jest.spyOn(Date, 'now').mockReturnValue(12_345);
    const request = {
      headers: { 'x-request-id': 'context-request-1', origin: 'https://tasks.example.com' },
      method: 'POST',
      url: '/tasks?ignored=true',
    } as unknown as FastifyRequest;
    const header = jest.fn();

    attachRequestContext(request, { header } as unknown as FastifyReply);

    expect(requestContextFor(request)).toEqual({
      requestId: 'context-request-1',
      method: 'POST',
      path: '/tasks',
      origin: 'https://tasks.example.com',
      startedAtMs: 12_345,
    });
    expect((request as FastifyRequest & { eisenhowerContext?: unknown }).eisenhowerContext)
      .toBe(requestContextFor(request));
    expect(header).toHaveBeenCalledWith('X-Request-ID', 'context-request-1');
  });
});
