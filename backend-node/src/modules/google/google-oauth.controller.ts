import {
  Body, Controller, Get, HttpException, Inject, Post, Query, Req, Res, UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GoogleOAuthService } from '../../application/googleOAuth';
import { requestContextFor } from '../../platform/http/request-context';
import { GOOGLE_OAUTH_SERVICE } from '../../platform/tokens';
import { PublicRoute, RequiredScopes } from '../security/security.decorators';
import { GoogleOAuthStartDto } from './google-oauth.dto';

@Controller('calendar/oauth')
export class GoogleOAuthController {
  constructor(@Inject(GOOGLE_OAUTH_SERVICE) private readonly oauth: GoogleOAuthService) {}

  @Get('callback')
  @PublicRoute()
  async callback(
    @Query('state') state: string | undefined,
    @Query('code') code: string | undefined,
    @Query('error') error: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    if (error !== undefined) throw new HttpException({ error: 'Google authorization was not completed' }, 400);
    if (!state || !code) throw new HttpException({ error: 'OAuth state and code are required' }, 400);
    try {
      const result = await this.oauth.callback(state, code);
      return reply.status(303).header('Location', result.returnUrl).send();
    } catch (caught) {
      if (caught instanceof Error && caught.message === 'invalid_oauth_state') {
        throw new HttpException({ error: 'Invalid or expired OAuth state' }, 400);
      }
      throw caught;
    }
  }

  @Post('start')
  @RequiredScopes('calendar:write')
  @UsePipes(new ValidationPipe({
    transform: true,
    exceptionFactory: () => new HttpException({ error: 'returnPath is required' }, 400),
  }))
  async start(@Req() request: FastifyRequest, @Body() body: GoogleOAuthStartDto) {
    const principal = requestContextFor(request).principal!;
    try {
      return await this.oauth.start(
        { tenantId: principal.tenantId, ownerId: principal.userId }, body.returnPath,
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'unsafe_return_path') {
        throw new HttpException({ error: 'Unsafe OAuth return path' }, 400);
      }
      throw error;
    }
  }

  @Post('disconnect')
  @RequiredScopes('calendar:write')
  async disconnect(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const principal = requestContextFor(request).principal!;
    await this.oauth.disconnect({ tenantId: principal.tenantId, ownerId: principal.userId });
    return reply.status(204).send();
  }
}
