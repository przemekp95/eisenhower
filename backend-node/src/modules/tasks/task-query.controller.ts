import { Controller, Get, Inject, Param, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { TaskQueryService } from '../../application/tasks/task-query.service';
import { requestContextFor } from '../../platform/http/request-context';
import { RequiredScopes } from '../security/security.decorators';
import { parseDelegatedTaskQuery, parseTaskListQuery } from './task-query.dto';

@Controller('tasks')
export class TaskQueryController {
  constructor(@Inject(TaskQueryService) private readonly queries: TaskQueryService) {}

  @Get('delegated')
  @RequiredScopes('tasks:read')
  listDelegated(@Req() request: FastifyRequest) {
    return this.queries.listDelegated(
      requestContextFor(request).principal!, parseDelegatedTaskQuery(request.url),
    );
  }

  @Get(':id')
  @RequiredScopes('tasks:read')
  async getOwned(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
  ) {
    const task = await this.queries.getOwned(requestContextFor(request).principal!, id);
    reply.header('ETag', `"${task.revision}"`);
    return task;
  }

  @Get()
  @RequiredScopes('tasks:read')
  async listOwned(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const query = parseTaskListQuery(request.url);
    const result = await this.queries.listOwned(requestContextFor(request).principal!, query);
    if (result.nextCursor) {
      reply.header('X-Next-Cursor', result.nextCursor);
      const lifecycle = query.lifecycle === 'active' ? '' : `&lifecycle=${query.lifecycle}`;
      reply.header(
        'Link',
        `<?limit=${query.limit}${lifecycle}&cursor=${encodeURIComponent(result.nextCursor)}>; rel="next"`,
      );
    }
    return result.tasks;
  }
}
