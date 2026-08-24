import { DynamicModule, Global, Module } from '@nestjs/common';
import type { CreateAppOptions } from '../../app-options';
import { CalendarInternalService } from '../../application/calendarInternal';
import {
  CALENDAR_INTERNAL_SERVICE, INTERNAL_HMAC_SERVICE,
} from '../../platform/tokens';
import { CalendarInboundController } from './calendar-inbound.controller';
import { CalendarOperationsController } from './calendar-operations.controller';
import { CalendarOutboxController } from './calendar-outbox.controller';
import { InternalHmacGuard } from './internal-hmac.guard';
import { InternalHmacService } from './internal-hmac.service';

@Global()
@Module({})
export class CalendarInternalModule {
  static register(options: CreateAppOptions): DynamicModule {
    const hmacKey = options.calendarInternalHmacKey ?? process.env.CALENDAR_INTERNAL_HMAC_KEY;
    return {
      global: true,
      module: CalendarInternalModule,
      controllers: hmacKey
        ? [CalendarInboundController, CalendarOutboxController, CalendarOperationsController]
        : [],
      providers: hmacKey ? [
        { provide: INTERNAL_HMAC_SERVICE, useValue: new InternalHmacService(hmacKey) },
        { provide: CALENDAR_INTERNAL_SERVICE, useValue: new CalendarInternalService() },
        InternalHmacGuard,
      ] : [],
      exports: hmacKey ? [INTERNAL_HMAC_SERVICE, InternalHmacGuard] : [],
    };
  }
}
