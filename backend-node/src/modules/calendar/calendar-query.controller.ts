import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CalendarApplicationService } from '../../application/calendar';
import { GoogleCalendarService } from '../../application/googleCalendar';
import { requestContextFor } from '../../platform/http/request-context';
import {
  CALENDAR_CAN_CONNECT, CALENDAR_SERVICE, GOOGLE_CALENDAR_SERVICE,
} from '../../platform/tokens';
import { RequiredScopes } from '../security/security.decorators';
import { calendarError, calendarScope } from './calendar.dto';

@Controller('calendar')
export class CalendarQueryController {
  constructor(
    @Inject(CALENDAR_SERVICE) private readonly calendar: CalendarApplicationService,
    @Inject(GOOGLE_CALENDAR_SERVICE) private readonly provider: GoogleCalendarService | null,
    @Inject(CALENDAR_CAN_CONNECT) private readonly canConnect: boolean,
  ) {}

  private principal(request: FastifyRequest) {
    return requestContextFor(request).principal!;
  }

  @Get('status')
  @RequiredScopes('calendar:read')
  status(@Req() request: FastifyRequest) {
    return this.calendar.status(calendarScope(this.principal(request)), this.canConnect);
  }

  @Get('events')
  @RequiredScopes('calendar:read')
  async events(@Req() request: FastifyRequest) {
    if (!this.provider) throw calendarError(404, 'Calendar provider is unavailable');
    const parameters = new URL(request.url, 'http://eisenhower.local').searchParams;
    const timeMin = parameters.get('timeMin') ?? '';
    const timeMax = parameters.get('timeMax') ?? '';
    const pageToken = parameters.get('pageToken') ?? undefined;
    const min = Date.parse(timeMin);
    const max = Date.parse(timeMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || max - min > 180 * 86_400_000) {
      throw calendarError(400, 'A valid event window of at most 180 days is required');
    }
    const connection = await this.calendar.activeConnection(calendarScope(this.principal(request)));
    if (!connection) throw calendarError(409, 'Calendar is disconnected');
    try {
      return await this.provider.candidateEvents(connection.id, {
        timeMin, timeMax, ...(pageToken ? { pageToken } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_connection_unavailable') {
        throw calendarError(409, 'Calendar is disconnected');
      }
      throw error;
    }
  }

  @Get('conflicts')
  @RequiredScopes('calendar:read')
  conflicts(@Req() request: FastifyRequest) {
    return this.calendar.listConflicts(calendarScope(this.principal(request)));
  }

  @Get('deleted-bindings')
  @RequiredScopes('calendar:read')
  deletedBindings(@Req() request: FastifyRequest) {
    return this.calendar.listDeletedBindings(calendarScope(this.principal(request)));
  }
}
