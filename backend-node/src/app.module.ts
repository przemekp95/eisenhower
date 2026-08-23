import { DynamicModule, Module } from '@nestjs/common';
import { CreateAppOptions } from './app-options';
import { HealthModule } from './modules/health/health.module';
import { SecurityModule } from './modules/security/security.module';
import { APP_OPTIONS } from './platform/tokens';

@Module({})
export class AppModule {
  static register(options: CreateAppOptions): DynamicModule {
    return {
      module: AppModule,
      imports: [SecurityModule.register(options), HealthModule.register(options)],
      providers: [{ provide: APP_OPTIONS, useValue: options }],
    };
  }
}
