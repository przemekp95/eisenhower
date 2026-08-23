import {
  Body, Controller, HttpException, Inject, Post, UseGuards,
} from '@nestjs/common';
import { GoogleCalendarService } from '../../application/googleCalendar';
import { GOOGLE_CALENDAR_SERVICE } from '../../platform/tokens';
import { InternalHmacGuard } from '../calendar-internal/internal-hmac.guard';
import { InternalRoute } from '../security/security.decorators';

@Controller('internal/calendar/provider')
@InternalRoute()
@UseGuards(InternalHmacGuard)
export class GoogleProviderController {
  constructor(@Inject(GOOGLE_CALENDAR_SERVICE) private readonly provider: GoogleCalendarService) {}

  private fail(error: unknown): never {
    if (error instanceof Error && error.message.endsWith('_denied')) {
      throw new HttpException({ error: 'Invalid provider request' }, 400);
    }
    if (error instanceof Error && (error.message.endsWith('_unavailable') || error.message.endsWith('_mismatch'))) {
      throw new HttpException({ error: 'Provider state is unavailable' }, 409);
    }
    throw error;
  }

  @Post('outbound')
  async outbound(@Body() body: Record<string, unknown>) {
    if (Object.keys(body ?? {}).length !== 1 || typeof body?.eventId !== 'string' || !body.eventId) {
      throw new HttpException({ error: 'eventId is required' }, 400);
    }
    try { return await this.provider.outbound(body.eventId); } catch (error) { return this.fail(error); }
  }

  @Post('changes')
  async changes(@Body() body: Record<string, unknown>) {
    if (Object.keys(body ?? {}).some((key) => !['connectionId', 'checkpoint'].includes(key))
      || typeof body?.connectionId !== 'string' || typeof body?.checkpoint !== 'string') {
      throw new HttpException({ error: 'connectionId and checkpoint are required' }, 400);
    }
    try { return await this.provider.changes(body.connectionId, body.checkpoint); } catch (error) { return this.fail(error); }
  }

  @Post('watch')
  async watch(@Body() body: Record<string, unknown>) {
    if (Object.keys(body ?? {}).some((key) => !['connectionId', 'address'].includes(key))
      || typeof body?.connectionId !== 'string' || typeof body?.address !== 'string') {
      throw new HttpException({ error: 'connectionId and address are required' }, 400);
    }
    try { return await this.provider.watch(body.connectionId, body.address); } catch (error) { return this.fail(error); }
  }
}
