import {
  Body, Controller, Inject, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CalendarInternalService } from '../../application/calendarInternal';
import { CALENDAR_INTERNAL_SERVICE } from '../../platform/tokens';
import { InternalRoute } from '../security/security.decorators';
import { sendInternalResult } from './calendar-internal.http';
import { InternalHmacGuard } from './internal-hmac.guard';
import {
  INTERNAL_HMAC_CONTEXT, InternalHmacRequest,
} from './internal-hmac.service';

@Controller('internal/calendar')
@InternalRoute()
@UseGuards(InternalHmacGuard)
export class CalendarOutboxController {
  constructor(@Inject(CALENDAR_INTERNAL_SERVICE) private readonly internal: CalendarInternalService) {}

  @Post(['outbound/claim', 'outbox/claim'])
  async claim(
    @Req() request: FastifyRequest & InternalHmacRequest,
    @Res() reply: FastifyReply,
  ) {
    const context = request[INTERNAL_HMAC_CONTEXT];
    if (!context) throw new Error('calendar_request_receipt_missing');
    return sendInternalResult(request, reply, await this.internal.claimOutbox(context));
  }

  @Post(['outbound/result', 'outbox/acknowledge'])
  async acknowledge(
    @Req() request: FastifyRequest & InternalHmacRequest,
    @Res() reply: FastifyReply,
    @Body() body: Record<string, unknown>,
  ) {
    return sendInternalResult(request, reply, await this.internal.acknowledgeOutbox(body ?? {}));
  }
}
