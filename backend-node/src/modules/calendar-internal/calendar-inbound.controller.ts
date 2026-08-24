import {
  Body, Controller, HttpException, Inject, Post, Req, Res, UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CalendarApplicationService, CalendarInboundCommand } from '../../application/calendar';
import { isCalendarInboundCommand } from '../../application/calendarInternal';
import { CALENDAR_SERVICE } from '../../platform/tokens';
import { InternalRoute } from '../security/security.decorators';
import { sendInternalResult } from './calendar-internal.http';
import { InternalHmacGuard } from './internal-hmac.guard';
import type { InternalHmacRequest } from './internal-hmac.service';

@Controller('internal/calendar')
@InternalRoute()
@UseGuards(InternalHmacGuard)
export class CalendarInboundController {
  constructor(@Inject(CALENDAR_SERVICE) private readonly calendar: CalendarApplicationService) {}

  private async apply(
    command: unknown,
    batch = false,
  ) {
    if (!isCalendarInboundCommand(command)) {
      throw new HttpException({
        error: batch ? 'Invalid calendar inbound command batch' : 'Invalid calendar inbound command',
      }, 400);
    }
    try {
      return await this.calendar.applyInbound(command);
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        throw new HttpException({ error: error.message }, 409);
      }
      throw error;
    }
  }

  @Post(['inbound', 'sync/apply'])
  async inbound(
    @Req() request: FastifyRequest & InternalHmacRequest,
    @Res() reply: FastifyReply,
    @Body() body: unknown,
  ) {
    const result = await this.apply(body);
    return sendInternalResult(request, reply, { status: 202, body: result });
  }

  @Post('sync/apply-batch')
  async batch(
    @Req() request: FastifyRequest & InternalHmacRequest,
    @Res() reply: FastifyReply,
    @Body() body: Record<string, unknown>,
  ) {
    const commands = body?.commands;
    if (!Array.isArray(commands) || !commands.length || commands.length > 250) {
      throw new HttpException({ error: 'Invalid calendar inbound command batch' }, 400);
    }
    const results = [];
    for (const command of commands) results.push(await this.apply(command, true));
    return sendInternalResult(request, reply, { status: 202, body: { results } });
  }

  @Post('sync/reset')
  async reset(
    @Req() request: FastifyRequest & InternalHmacRequest,
    @Res() reply: FastifyReply,
    @Body() body: Record<string, unknown>,
  ) {
    const { operationId, tenantId, ownerId, connectionId } = body ?? {};
    if (![operationId, tenantId, ownerId, connectionId]
      .every((value) => typeof value === 'string' && value)) {
      throw new HttpException({ error: 'Invalid calendar sync reset' }, 400);
    }
    const result = await this.calendar.applyInbound({
      operationId: operationId as string,
      tenantId: tenantId as string,
      ownerId: ownerId as string,
      connectionId: connectionId as string,
      kind: 'sync_token_gone',
    });
    return sendInternalResult(request, reply, { status: 202, body: result });
  }

  @Post('request')
  async requestSync(
    @Req() request: FastifyRequest & InternalHmacRequest,
    @Res() reply: FastifyReply,
    @Body() body: Record<string, unknown>,
  ) {
    const { tenantId, ownerId, connectionId, operationId } = body ?? {};
    if (![tenantId, ownerId, connectionId, operationId]
      .every((value) => typeof value === 'string' && value)) {
      throw new HttpException({ error: 'Invalid calendar sync request' }, 400);
    }
    try {
      const result = await this.calendar.requestSync(
        { tenantId: tenantId as string, ownerId: ownerId as string },
        connectionId as string,
        operationId as string,
      );
      return sendInternalResult(request, reply, { status: 202, body: result });
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        throw new HttpException({ error: error.message }, 409);
      }
      throw error;
    }
  }
}
