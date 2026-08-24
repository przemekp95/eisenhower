import { DynamicModule, Module } from '@nestjs/common';
import { CreateAppOptions } from './app-options';
import { AppConfig } from './config';
import { HealthModule } from './modules/health/health.module';
import { SecurityModule } from './modules/security/security.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CalendarModule } from './modules/calendar/calendar.module';
import { GoogleModule } from './modules/google/google.module';
import { CalendarInternalModule } from './modules/calendar-internal/calendar-internal.module';
import { APP_OPTIONS } from './platform/tokens';

@Module({})
export class AppModule {
  static register(options: CreateAppOptions, config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        SecurityModule.register(options, config),
        HealthModule.register(options, config),
        TasksModule.register(options),
        CalendarModule.register(options),
        CalendarInternalModule.register(options),
        GoogleModule.register(options, config),
      ],
      providers: [
        { provide: APP_OPTIONS, useValue: options },
      ],
    };
  }
}
