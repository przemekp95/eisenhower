import { DynamicModule, Module } from '@nestjs/common';
import type { CreateAppOptions } from '../../app-options';
import { CalendarApplicationService } from '../../application/calendar';
import { CALENDAR_SERVICE } from '../../platform/tokens';
import { CalendarCommandController } from './calendar-command.controller';
import { CalendarQueryController } from './calendar-query.controller';

@Module({})
export class CalendarModule {
  static register(options: CreateAppOptions): DynamicModule {
    return {
      module: CalendarModule,
      controllers: [CalendarQueryController, CalendarCommandController],
      providers: [
        { provide: CALENDAR_SERVICE, useValue: options.calendarApplicationService ?? new CalendarApplicationService() },
      ],
    };
  }
}
