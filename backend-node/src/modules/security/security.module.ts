import { DynamicModule, Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { CreateAppOptions } from '../../app-options';
import { loadConfig } from '../../config';
import { AuditService } from './audit.service';
import { SecurityGuard } from './security.guard';
import { SecurityService } from './security.service';

@Global()
@Module({})
export class SecurityModule {
  static register(options: CreateAppOptions): DynamicModule {
    const config = loadConfig();
    return {
      global: true,
      module: SecurityModule,
      providers: [
        {
          provide: AuditService,
          useFactory: () => new AuditService(options, config),
        },
        {
          provide: SecurityService,
          useFactory: () => new SecurityService(config, options),
        },
        SecurityGuard,
        { provide: APP_GUARD, useExisting: SecurityGuard },
      ],
      exports: [AuditService, SecurityService],
    };
  }
}
