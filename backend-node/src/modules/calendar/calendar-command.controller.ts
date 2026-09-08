import {
  Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CalendarApplicationService } from '../../application/calendar';
import { GoogleCalendarService } from '../../application/googleCalendar';
import { requestContextFor } from '../../platform/http/request-context';
import { CALENDAR_SERVICE, GOOGLE_CALENDAR_SERVICE } from '../../platform/tokens';
import { RequiredScopes } from '../security/security.decorators';
import {
  calendarError, calendarRevision, calendarScope, requireIdempotencyKey,
} from './calendar.dto';

@Controller('calendar')
export class CalendarCommandController {
  constructor(
    @Inject(CALENDAR_SERVICE) private readonly calendar: CalendarApplicationService,
    @Inject(GOOGLE_CALENDAR_SERVICE) private readonly provider: GoogleCalendarService | null,
  ) {}

  private principal(request: FastifyRequest) {
    return requestContextFor(request).principal!;
  }

  @Post('sync-requests')
  @RequiredScopes('calendar:write')
  async requestSync(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Headers('idempotency-key') key?: string,
  ) {
    const operationId = requireIdempotencyKey(key);
    const scope = calendarScope(this.principal(request));
    const connection = await this.calendar.activeConnection(scope);
    if (!connection) throw calendarError(409, 'Calendar is disconnected');
    try {
      const result = await this.calendar.requestSync(scope, connection.id, operationId);
      reply.status(202);
      return result;
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        throw calendarError(409, error.message);
      }
      throw error;
    }
  }

  @Post('bindings/preview')
  @HttpCode(200)
  @RequiredScopes('calendar:read')
  async preview(@Req() request: FastifyRequest, @Body() body: Record<string, unknown>) {
    if (!this.provider) throw calendarError(404, 'Calendar provider is unavailable');
    if (typeof body?.taskId !== 'string' || typeof body?.providerEventId !== 'string') {
      throw calendarError(400, 'taskId and providerEventId are required');
    }
    try {
      return await this.provider.previewLink(
        calendarScope(this.principal(request)), body.taskId, body.providerEventId,
      );
    } catch (error) {
      if (error instanceof Error && ['calendar_link_target_unavailable', 'calendar_link_not_unique'].includes(error.message)) {
        throw calendarError(409, error.message);
      }
      throw error;
    }
  }

  @Post('bindings')
  @RequiredScopes('calendar:write')
  async bind(
    @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Body() body: Record<string, unknown>, @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!this.provider) throw calendarError(404, 'Calendar provider is unavailable');
    const expectedTaskRevision = calendarRevision(ifMatch);
    if (expectedTaskRevision === null || !key) {
      throw calendarError(428, 'If-Match and Idempotency-Key are required');
    }
    if (
      typeof body?.taskId !== 'string' || typeof body?.providerEventId !== 'string'
      || typeof body?.providerEtag !== 'string'
      || !['google_to_eisenhower', 'eisenhower_to_google'].includes(String(body?.direction))
    ) throw calendarError(400, 'Invalid calendar binding command');
    try {
      const principal = this.principal(request);
      const result = await this.provider.linkExisting({
        ...calendarScope(principal), actorId: principal.userId, operationId: key,
        taskId: body.taskId, expectedTaskRevision, providerEventId: body.providerEventId,
        providerEtag: body.providerEtag,
        direction: body.direction as 'google_to_eisenhower' | 'eisenhower_to_google',
      });
      reply.status(201);
      return result;
    } catch (error) {
      if (error instanceof Error) {
        if (['calendar_task_revision_mismatch', 'calendar_provider_revision_mismatch'].includes(error.message)) {
          throw calendarError(412, error.message);
        }
        if (['calendar_operation_reused', 'calendar_link_target_unavailable', 'calendar_link_not_unique', 'calendar_link_schedule_missing'].includes(error.message)) {
          throw calendarError(409, error.message);
        }
      }
      throw error;
    }
  }

  @Post('imports')
  @HttpCode(200)
  @RequiredScopes('calendar:write')
  async imports(
    @Req() request: FastifyRequest, @Body() body: Record<string, unknown>,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!this.provider) throw calendarError(404, 'Calendar provider is unavailable');
    const operationId = requireIdempotencyKey(key);
    const ids = body?.providerEventIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !id)) {
      throw calendarError(400, 'Select between 1 and 20 provider events');
    }
    const principal = this.principal(request);
    try {
      return await this.provider.importSelected({
        ...calendarScope(principal), actorId: principal.userId, operationId,
        providerEventIds: ids as string[],
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_connection_unavailable') {
        throw calendarError(409, 'Calendar is disconnected');
      }
      throw error;
    }
  }

  @Post('deleted-bindings/:id/resolve')
  @HttpCode(200)
  @RequiredScopes('calendar:write')
  async resolveDeletion(
    @Req() request: FastifyRequest, @Param('id') id: string,
    @Body() body: Record<string, unknown>, @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') key?: string,
  ) {
    const expectedTaskRevision = calendarRevision(ifMatch);
    if (expectedTaskRevision === null) throw calendarError(428, 'If-Match is required');
    const operationId = requireIdempotencyKey(key);
    if (!['clear_date', 'recreate', 'detach'].includes(String(body?.strategy))) {
      throw calendarError(400, 'strategy must be clear_date, recreate or detach');
    }
    const principal = this.principal(request);
    try {
      return await this.calendar.resolveProviderDeletion({
        ...calendarScope(principal), operationId, actorId: principal.userId, bindingId: id,
        expectedTaskRevision, strategy: body.strategy as 'clear_date' | 'recreate' | 'detach',
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'calendar_deleted_binding_not_found') throw calendarError(404, 'Deleted calendar binding not found');
        if (error.message === 'calendar_task_revision_mismatch') throw calendarError(412, 'Task revision conflict');
        if (['calendar_conflict_target_unavailable', 'calendar_recreate_schedule_missing'].includes(error.message)) {
          throw calendarError(409, 'Calendar deletion target is unavailable');
        }
        if (error.message === 'calendar_operation_reused') throw calendarError(409, error.message);
      }
      throw error;
    }
  }

  @Post('conflicts/:id/resolve')
  @HttpCode(200)
  @RequiredScopes('calendar:write')
  async resolveConflict(
    @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string, @Body() body: Record<string, unknown>,
    @Headers('if-match') ifMatch?: string, @Headers('idempotency-key') key?: string,
  ) {
    const expectedRevision = calendarRevision(ifMatch);
    if (expectedRevision === null) throw calendarError(428, 'If-Match is required');
    const operationId = requireIdempotencyKey(key);
    if (!['eisenhower', 'google'].includes(String(body?.strategy))) {
      throw calendarError(400, 'strategy must be eisenhower or google');
    }
    const principal = this.principal(request);
    try {
      const result = await this.calendar.resolveConflict({
        ...calendarScope(principal), operationId, actorId: principal.userId,
        conflictId: id, expectedRevision,
        strategy: body.strategy as 'eisenhower' | 'google',
      });
      reply.header('ETag', `"${result.revision}"`);
      return result.conflict;
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'calendar_conflict_not_found') throw calendarError(404, 'Calendar conflict not found');
        if (error.message === 'calendar_conflict_revision_mismatch') throw calendarError(412, 'Calendar conflict revision conflict');
        if (error.message === 'calendar_conflict_target_unavailable') throw calendarError(409, 'Conflict target is unavailable');
        if (error.message === 'calendar_operation_reused') throw calendarError(409, error.message);
      }
      throw error;
    }
  }
}
