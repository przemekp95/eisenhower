import { HttpException } from '@nestjs/common';

export const calendarError = (status: number, error: string) => new HttpException({ error }, status);

export function calendarRevision(value: string | undefined) {
  const match = /^"(\d+)"$/.exec(value ?? '');
  return match ? Number(match[1]) : null;
}

export function requireIdempotencyKey(value: string | undefined) {
  if (!value) throw calendarError(428, 'Idempotency-Key is required');
  return value;
}

export function calendarScope(principal: { tenantId: string; userId: string }) {
  return { tenantId: principal.tenantId, ownerId: principal.userId };
}
