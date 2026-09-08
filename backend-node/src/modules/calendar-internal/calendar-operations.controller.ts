import {
  Body, Controller, Inject, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CalendarInternalService } from '../../application/calendarInternal';
import { CALENDAR_INTERNAL_SERVICE } from '../../platform/tokens';
import { InternalRoute } from '../security/security.decorators';
import { sendInternalResult } from './calendar-internal.http';
import { InternalHmacGuard } from './internal-hmac.guard';
import type { InternalHmacRequest } from './internal-hmac.service';

@Controller('internal/calendar')
@InternalRoute()
@UseGuards(InternalHmacGuard)
export class CalendarOperationsController {
  constructor(@Inject(CALENDAR_INTERNAL_SERVICE) private readonly internal: CalendarInternalService) {}

  private run(
    request: FastifyRequest & InternalHmacRequest,
    reply: FastifyReply,
    operation: Promise<{ status: number; body?: unknown }>,
  ) {
    return operation.then((result) => sendInternalResult(request, reply, result));
  }

  @Post('notifications/validate')
  notification(@Req() request: FastifyRequest & InternalHmacRequest, @Res() reply: FastifyReply, @Body() body: Record<string, unknown>) {
    return this.run(request, reply, this.internal.validateNotification(body ?? {}));
  }

  @Post('watch/renew')
  renew(@Req() request: FastifyRequest & InternalHmacRequest, @Res() reply: FastifyReply, @Body() body: Record<string, unknown>) {
    return this.run(request, reply, this.internal.renewWatch(body ?? {}));
  }

  @Post('reconciliation/claim')
  reconciliation(@Req() request: FastifyRequest & InternalHmacRequest, @Res() reply: FastifyReply) {
    return this.run(request, reply, this.internal.claimReconciliation());
  }

  @Post('status')
  status(@Req() request: FastifyRequest & InternalHmacRequest, @Res() reply: FastifyReply, @Body() body: Record<string, unknown>) {
    return this.run(request, reply, this.internal.status(body ?? {}));
  }
}
