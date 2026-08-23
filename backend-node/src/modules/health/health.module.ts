import { DynamicModule, Module } from '@nestjs/common';
import { CreateAppOptions } from '../../app-options';
import { loadConfig } from '../../config';
import { getDatabaseStatus } from '../../db';
import { AI_HEALTH_CHECKER, DATABASE_STATUS_RESOLVER } from '../../platform/tokens';
import { HealthController } from './health.controller';
import { defaultAiHealthChecker, HealthService } from './health.service';

@Module({})
export class HealthModule {
  static register(options: CreateAppOptions): DynamicModule {
    const config = loadConfig();
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        HealthService,
        {
          provide: AI_HEALTH_CHECKER,
          useValue: options.aiHealthChecker ?? (() => defaultAiHealthChecker(config.aiServiceUrl)),
        },
        {
          provide: DATABASE_STATUS_RESOLVER,
          useValue: options.databaseStatusResolver ?? getDatabaseStatus,
        },
      ],
    };
  }
}
